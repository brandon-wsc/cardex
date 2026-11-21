---- MODULE ProposalLifecycleFixed ----
\* Fixed version of ProposalLifecycle. The fix: the guard moves into the
\* write itself — every decide write is a conditional UPDATE matching
\* WHERE id = ? AND status = 'pending'. A zero-row result is reported as
\* already_decided. The JS guard on the stale SELECT disappears.
\*
\* Approve becomes two atomic steps (D1 batch cannot roll back on a
\* zero-row UPDATE, so the claim is its own statement):
\*   Claim:  UPDATE ... SET status='applying' WHERE id=? AND status='pending'
\*   Apply:  revalidate, then batch(patches + UPDATE ... SET status='applied')
\* Reject stays one step, now conditional:
\*   UPDATE ... SET status='rejected' WHERE id=? AND status='pending'
\*
\* 'observed' survives only for the not_found / fast-path UX — nothing
\* safety-critical reads it any more.
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Proposals, Approvers, MaxPending

\* See ProposalLifecycle.tla — worst case, all distinct pairs conflict.
Conflict == {<<p, q>> \in Proposals \X Proposals : p # q}

VARIABLES status,     \* status[p] adds "applying": the claim is held
          applied,
          decision,
          stale,
          target,
          observed,
          pc          \* pc[a] in {"idle","decide","apply"}

vars == <<status, applied, decision, stale, target, observed, pc>>

PendingCount == Cardinality({p \in Proposals : status[p] = "pending"})

Init ==
  /\ status   = [p \in Proposals |-> "absent"]
  /\ applied  = [p \in Proposals |-> 0]
  /\ decision = [p \in Proposals |-> "none"]
  /\ stale    = [p \in Proposals |-> FALSE]
  /\ target   = [a \in Approvers |-> "none"]
  /\ observed = [a \in Approvers |-> "none"]
  /\ pc       = [a \in Approvers |-> "idle"]

Propose(p) ==
  /\ status[p] = "absent"
  /\ PendingCount < MaxPending
  /\ status' = [status EXCEPT ![p] = "pending"]
  /\ UNCHANGED <<applied, decision, stale, target, observed, pc>>

\* Still an independent read — used for 404 and the UX fast path.
\* Safety no longer depends on what it returns.
Select(a, p) ==
  /\ pc[a] = "idle"
  /\ status[p] # "absent"
  /\ observed' = [observed EXCEPT ![a] = status[p]]
  /\ target'   = [target EXCEPT ![a] = p]
  /\ pc'       = [pc EXCEPT ![a] = "decide"]
  /\ UNCHANGED <<status, applied, decision, stale>>

\* FIX: the claim is a single conditional UPDATE — an atomic CAS.
\* Whoever's claim lands first wins; the loser matches zero rows.
Claim(a) ==
  /\ pc[a] = "decide"
  /\ LET p == target[a] IN
       IF status[p] = "pending" THEN            \* LIVE status, not observed[a]
         /\ status' = [status EXCEPT ![p] = "applying"]
         /\ pc'     = [pc EXCEPT ![a] = "apply"]
       ELSE                                     \* zero rows => already_decided
         /\ pc' = [pc EXCEPT ![a] = "idle"]
         /\ UNCHANGED status
  /\ UNCHANGED <<applied, decision, stale, target, observed>>

\* Second phase: revalidate, then the patch batch + final UPDATE.
Apply(a) ==
  /\ pc[a] = "apply"
  /\ LET p == target[a] IN
       IF stale[p] THEN
         \* apply-time revalidation failed — the claim must be released
         \* back to 'pending' (or owner rejects). An explicit second write.
         /\ status' = [status EXCEPT ![p] = "pending"]
         /\ UNCHANGED <<applied, decision, stale>>
       ELSE
         /\ status'   = [status EXCEPT ![p] = "applied"]
         /\ applied'  = [applied EXCEPT ![p] = @ + 1]
         /\ decision' = [decision EXCEPT ![p] = IF @ = "none" THEN "applied" ELSE @]
         /\ stale'    = [q \in Proposals |->
                          stale[q] \/ (q # p /\ <<p,q>> \in Conflict)]
  /\ pc' = [pc EXCEPT ![a] = "idle"]
  /\ UNCHANGED <<target, observed>>

\* A failed batch leaves the claim held — nothing in the code releases
\* 'applying'. Keep this action to see the recovery obligation the fix
\* creates (a wedged 'applying' needs a sweeper or manual reset).
\* Delete it from Next to model "batches never fail".
ApplyFail(a) ==
  /\ pc[a] = "apply"
  /\ pc' = [pc EXCEPT ![a] = "idle"]
  /\ UNCHANGED <<status, applied, decision, stale, target, observed>>

\* FIX: reject's UPDATE is now conditional — one atomic conditional write.
\* If an approve claimed the proposal first (status='applying'), this
\* matches zero rows and returns already_decided instead of overwriting.
RejectFixed(a) ==
  /\ pc[a] = "decide"
  /\ LET p == target[a] IN
       IF status[p] = "pending" THEN
         /\ status'   = [status EXCEPT ![p] = "rejected"]
         /\ decision' = [decision EXCEPT ![p] =
                          IF @ = "none" THEN "rejected" ELSE @]
       ELSE UNCHANGED <<status, decision>>
  /\ pc' = [pc EXCEPT ![a] = "idle"]
  /\ UNCHANGED <<applied, stale, target, observed>>

Next ==
  \/ \E p \in Proposals : Propose(p)
  \/ \E a \in Approvers, p \in Proposals : Select(a, p)
  \/ \E a \in Approvers : Claim(a) \/ Apply(a) \/ ApplyFail(a) \/ RejectFixed(a)

Spec == Init /\ [][Next]_vars

\* --- invariants ---------------------------------------------------------

AtMostOnce ==
  \A p \in Proposals : applied[p] <= 1

DecisionsFinal ==
  \A p \in Proposals : decision[p] # "none" => status[p] = decision[p]

\* Optional liveness check — add to the .cfg as:
\*   PROPERTY EventuallyTerminal
\*   and fairness on the progress actions, e.g.
\*   Spec == Init /\ [][Next]_vars /\ WF_vars(Apply) ...
\* With ApplyFail enabled it fails: a crashed apply wedges 'applying'
\* forever. That failure is the recovery obligation — a sweeper that
\* reverts stale 'applying' rows, or an owner-visible reset.
EventuallyTerminal ==
  \A p \in Proposals :
    (status[p] \in {"pending", "applying"}) ~>
      (status[p] \in {"applied", "rejected"})

=============================================================================
