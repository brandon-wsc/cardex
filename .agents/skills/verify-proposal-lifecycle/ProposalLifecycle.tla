---- MODULE ProposalLifecycle ----
\* Model of decideProposal as written in packages/mcp-worker/src/maintain.ts.
\* The decide path is two separate atomic steps — an awaited SELECT, then a
\* write (a single UPDATE for reject, a db.batch for approve). Everything
\* between the two awaits can interleave with another approver's steps.
\*
\* TLC finds two violations:
\*   - overlap-read: two approvers both observe "pending", both write
\*   - decision-override: reject's unconditional UPDATE lands after an
\*     approve committed, flipping status back over already-applied facts
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Proposals,      \* proposal ids, e.g. {"p1","p2"}
          Approvers,      \* concurrent deciders, e.g. {"a1","a2"}
          MaxPending      \* PROPOSAL_MAX.pending (prod 100; model small)

\* Which proposals touch the same facts rows. Worst case: all distinct
\* pairs conflict. To model partial overlap, redefine as a subset of
\* off-diagonal pairs (kept symmetric) — cfg tuple syntax is fragile.
Conflict == {<<p, q>> \in Proposals \X Proposals : p # q}

VARIABLES status,     \* status[p]   in {"absent","pending","applied","rejected"}
          applied,    \* applied[p]  in Nat — ghost counter: times patches landed
          decision,   \* decision[p] in {"none","applied","rejected"} — 1st decision
          stale,      \* stale[p] — a conflicting proposal has applied since
          target,     \* target[a] — the proposal approver a is deciding on
          observed,   \* observed[a] — what approver a's SELECT returned
          pc          \* pc[a] in {"idle","decide"}

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

\* proposeChange: queue cap, then INSERT status='pending'.
\* Patch validation at submit time is abstracted away — what matters is
\* that validity can change before the decision (see stale below).
Propose(p) ==
  /\ status[p] = "absent"
  /\ PendingCount < MaxPending
  /\ status' = [status EXCEPT ![p] = "pending"]
  /\ UNCHANGED <<applied, decision, stale, target, observed, pc>>

\* await #1: SELECT status, patches FROM proposals WHERE id = ?
Select(a, p) ==
  /\ pc[a] = "idle"
  /\ status[p] # "absent"
  /\ observed' = [observed EXCEPT ![a] = status[p]]
  /\ target'   = [target EXCEPT ![a] = p]
  /\ pc'       = [pc EXCEPT ![a] = "decide"]
  /\ UNCHANGED <<status, applied, decision, stale>>

\* approve: the JS guard reads observed (a stale snapshot), then one atomic
\* db.batch applies the patches and UPDATEs status WHERE id = ? — the WHERE
\* has no status clause, so a second overlapping approver re-applies.
Approve(a) ==
  /\ pc[a] = "decide"
  /\ LET p == target[a] IN
       IF observed[a] # "pending" THEN
         \* already_decided — guard catches prior decisions only
         UNCHANGED <<status, applied, decision, stale>>
       ELSE IF stale[p] THEN
         \* apply-time revalidation fails — proposal stays pending
         UNCHANGED <<status, applied, decision, stale>>
       ELSE
         \* batch commits: patch statements + UPDATE ... WHERE id = ?
         /\ status'   = [status EXCEPT ![p] = "applied"]
         /\ applied'  = [applied EXCEPT ![p] = @ + 1]
         /\ decision' = [decision EXCEPT ![p] = IF @ = "none" THEN "applied" ELSE @]
         /\ stale'    = [q \in Proposals |->
                          stale[q] \/ (q # p /\ <<p,q>> \in Conflict)]
  /\ pc' = [pc EXCEPT ![a] = "idle"]
  /\ UNCHANGED <<target, observed>>

\* reject: same shape of bug — guarded by the stale read, then an
\* unconditional UPDATE ... WHERE id = ?. If an approve batch committed
\* in between, this overwrites 'applied' with 'rejected' while the facts
\* are already in the tables.
Reject(a) ==
  /\ pc[a] = "decide"
  /\ LET p == target[a] IN
       /\ IF observed[a] = "pending"
            THEN /\ status'   = [status EXCEPT ![p] = "rejected"]
                 /\ decision' = [decision EXCEPT ![p] =
                                  IF @ = "none" THEN "rejected" ELSE @]
            ELSE UNCHANGED <<status, decision>>
       /\ pc' = [pc EXCEPT ![a] = "idle"]
  /\ UNCHANGED <<applied, stale, target, observed>>

Next ==
  \/ \E p \in Proposals : Propose(p)
  \/ \E a \in Approvers, p \in Proposals : Select(a, p)
  \/ \E a \in Approvers : Approve(a) \/ Reject(a)

Spec == Init /\ [][Next]_vars

\* --- invariants ---------------------------------------------------------

\* Patches land at most once per proposal.
AtMostOnce ==
  \A p \in Proposals : applied[p] <= 1

\* The first decision is final — nobody can overwrite it.
DecisionsFinal ==
  \A p \in Proposals : decision[p] # "none" => status[p] = decision[p]

=============================================================================
