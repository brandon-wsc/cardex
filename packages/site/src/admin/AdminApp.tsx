import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface MeRes {
  email?: string;
  pin_required?: boolean;
}
interface ProposalRow {
  id: string;
  proposed_by?: string;
  summary?: string;
  evidence_url?: string;
  status: string;
  created_at?: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  patch_count: number;
}
interface ProposalsRes {
  proposals?: ProposalRow[];
}
interface Report {
  id: string;
  target_kind?: string;
  target_id?: string;
  field?: string;
  claimed_value?: string;
  evidence_url?: string;
  note?: string;
  reported_at?: string;
}
interface ReportsRes {
  reports?: Report[];
}
interface Patch {
  op: string;
  table: string;
  id: string;
  key?: Record<string, unknown>;
  set?: Record<string, unknown>;
  old?: Record<string, unknown> | null;
  raw?: unknown;
}
interface ProposalDetail {
  id: string;
  proposed_by?: string;
  summary?: string;
  evidence_url?: string;
  excerpt?: string;
  status: string;
  created_at?: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  patches: Patch[];
}
interface DetailRes {
  ok?: boolean;
  proposal?: ProposalDetail;
}
interface DecideRes {
  ok?: boolean;
  error?: string;
  detail?: string;
}

type Tab = "queue" | "history" | "reports";

async function api<T>(path: string, opts?: unknown): Promise<T> {
  const res = await fetch(
    "/admin/api" + path,
    opts !== undefined
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opts),
        }
      : undefined,
  );
  return res.json() as Promise<T>;
}

function fmtAge(iso?: string) {
  if (!iso) return "—";
  const h = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 3600000),
  );
  if (h < 1) return "just now";
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ") + "Z";
}

// evidence_url arrives from public report_issue / maintainer proposals —
// untrusted. Only http(s) renders as a link; anything else shows as plain
// text so a javascript: URL can never execute in the admin origin.
function safeHref(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function evidenceLink(url?: string) {
  if (!url) return "—";
  const href = safeHref(url);
  if (!href) return <span class="muted">{url}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      link ↗
    </a>
  );
}

function chip(status: string) {
  return <span class={"chip " + status}>{status}</span>;
}

function diffRow(field: string, oldV: unknown, newV: unknown) {
  return (
    <div class="diff-row">
      <span class="field">{field}</span>
      <span class="old">
        {oldV === undefined ? "—" : JSON.stringify(oldV)}
      </span>
      <span class="arrow">→</span>
      <span class="new">{JSON.stringify(newV)}</span>
    </div>
  );
}

function patchCard(patch: Patch) {
  const rows: ComponentChildren[] = [];
  if (patch.op === "insert") {
    const set = patch.set || {};
    const clash = patch.old || null;
    if (clash) {
      rows.push(
        <div class="diff-row">
          <span class="del">
            row already exists — insert will fail on apply
          </span>
        </div>,
      );
    }
    for (const k of Object.keys(set)) {
      rows.push(
        clash ? (
          diffRow(k, clash[k], set[k])
        ) : (
          <div class="diff-row">
            <span class="field">{k}</span>
            <span class="ins">{"+ " + JSON.stringify(set[k])}</span>
          </div>
        ),
      );
    }
  } else if (patch.op === "update") {
    const old = patch.old || {};
    const set = patch.set || {};
    for (const k of Object.keys(set)) {
      rows.push(diffRow(k, old[k], set[k]));
    }
  } else if (patch.op === "delete") {
    const old = patch.old || {};
    for (const k of Object.keys(old)) {
      rows.push(
        <div class="diff-row">
          <span class="field">{k}</span>
          <span class="del">{JSON.stringify(old[k])}</span>
        </div>,
      );
    }
    if (!Object.keys(old).length) {
      rows.push(
        <div class="diff-row">
          <span class="del">row not found — nothing to delete</span>
        </div>,
      );
    }
  }
  return (
    <div class="patch">
      <div class="patch-head">
        <span class={"chip op-" + patch.op}>{patch.op.toUpperCase()}</span>
        <span class="mono">{patch.table}</span>
        <span class="target">{patch.id}</span>
      </div>
      <div class="patch-rows">{rows}</div>
    </div>
  );
}

export default function AdminApp() {
  const [me, setMe] = useState("");
  const [pinRequired, setPinRequired] = useState(false);
  const [tab, setTab] = useState<Tab>("queue");
  const [queue, setQueue] = useState<ProposalRow[]>([]);
  const [decided, setDecided] = useState<ProposalRow[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    id: string;
    patches: number;
  } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  async function refresh() {
    const meRes = await api<MeRes>("/me");
    setMe(meRes.email || "?");
    setPinRequired(!!meRes.pin_required);
    const [pending, applied, reportsRes] = await Promise.all([
      api<ProposalsRes>("/proposals?status=pending"),
      api<ProposalsRes>("/proposals?status=applied"),
      api<ReportsRes>("/reports"),
    ]);
    const rejected = await api<ProposalsRes>("/proposals?status=rejected");
    setQueue(pending.proposals || []);
    setDecided(
      [...(applied.proposals || []), ...(rejected.proposals || [])].sort(
        (a, b) => (b.decided_at || "").localeCompare(a.decided_at || ""),
      ),
    );
    setReports(reportsRes.reports || []);
  }

  async function openDetail(id: string) {
    setDetailBusy(true);
    setDetail(null);
    const res = await api<DetailRes>("/proposals/" + encodeURIComponent(id));
    setDetailBusy(false);
    setDetail(res.ok && res.proposal ? res.proposal : null);
  }

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }

  async function decide(decision: "approve" | "reject", note?: string, pin?: string) {
    if (!detail) return;
    const res = await api<DecideRes>(
      "/proposals/" + encodeURIComponent(detail.id) + "/decide",
      { decision, note, pin },
    );
    if (!res.ok) {
      showToast("Failed: " + (res.detail || res.error || "unknown"));
      return;
    }
    setConfirm(null);
    showToast(
      decision === "approve" ? "Applied — patches written to facts" : "Rejected",
    );
    setDetail(null);
    await refresh();
  }

  useEffect(() => {
    refresh().catch((e) =>
      setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!confirm) return;
    (pinRef.current || confirmBtnRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirm(null);
      if (
        e.key === "Enter" &&
        document.activeElement &&
        (document.activeElement as HTMLElement).id === "pin"
      ) {
        confirmBtnRef.current?.click();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm]);

  function proposalRow(p: ProposalRow, decidedList: boolean) {
    return (
      <tr class="clickable" onClick={() => openDetail(p.id)}>
        <td>
          <div style="font-weight:500">{p.summary}</div>
          <div class="faint mono">
            {p.id} · by {p.proposed_by}
          </div>
        </td>
        <td class="mono" style="text-align:right">
          {p.patch_count} op{p.patch_count === 1 ? "" : "s"}
        </td>
        <td
          class="mono"
          onClick={(e) => e.stopPropagation()}
        >
          {evidenceLink(p.evidence_url)}
        </td>
        <td class="mono muted">
          {decidedList ? fmtTs(p.decided_at) : fmtAge(p.created_at)}
        </td>
        <td>
          {chip(p.status)}
          {p.decision_note ? (
            <div class="faint" style="margin-top:4px">
              {p.decision_note}
            </div>
          ) : null}
        </td>
      </tr>
    );
  }

  function listTable(rows: ProposalRow[], decidedList: boolean) {
    if (!rows.length) return <div class="empty">Nothing here.</div>;
    return (
      <div class="table-scroll">
        <table class="list">
          <thead>
            <tr>
              <th>Proposal</th>
              <th style="text-align:right">Patches</th>
              <th>Evidence</th>
              <th>{decidedList ? "Decided" : "Proposed"}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>{rows.map((p) => proposalRow(p, decidedList))}</tbody>
        </table>
      </div>
    );
  }

  function reportsTable() {
    if (!reports.length)
      return <div class="empty">No reports in quarantine.</div>;
    return (
      <div class="table-scroll wide">
        <table class="list">
          <thead>
            <tr>
              <th>Target</th>
              <th>Field</th>
              <th>Claimed</th>
              <th>Evidence</th>
              <th>Note</th>
              <th>Reported</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr class={r.evidence_url ? undefined : "dim-row"}>
                <td class="mono">
                  {r.target_kind}:{r.target_id}
                </td>
                <td class="mono">{r.field}</td>
                <td class="mono">{r.claimed_value}</td>
                <td class="mono">{evidenceLink(r.evidence_url)}</td>
                <td class="muted">{r.note || "—"}</td>
                <td class="mono muted">{fmtTs(r.reported_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function onReject() {
    const note = noteRef.current ? noteRef.current.value.trim() : "";
    if (!note) {
      showToast("Reject needs a decision note");
      return;
    }
    void decide("reject", note);
  }

  function onApprove() {
    if (!detail) return;
    setConfirm({ id: detail.id, patches: detail.patches.length });
  }

  function onConfirmApply() {
    const note = noteRef.current ? noteRef.current.value.trim() : "";
    void decide(
      "approve",
      note || undefined,
      pinRef.current ? pinRef.current.value : undefined,
    );
  }

  function detailView() {
    if (detailBusy) return <div class="empty">Loading…</div>;
    const p = detail;
    if (!p) return <div class="empty">Proposal not found.</div>;
    const pending = p.status === "pending";
    return (
      <>
        <button class="back-link" onClick={() => setDetail(null)}>
          ← Back to queue
        </button>
        <div class="card">
          <div class="faint mono" style="margin-bottom:6px">
            {p.id} {chip(p.status)} by {p.proposed_by} · {fmtAge(p.created_at)}
          </div>
          <div class="page-title" style="font-size:16px">
            {p.summary}
          </div>
          {p.decided_by ? (
            <p class="muted" style="margin:10px 0 0">
              Decided by {p.decided_by} at {fmtTs(p.decided_at)}
              {p.decision_note ? " — " + p.decision_note : ""}
            </p>
          ) : null}
        </div>
        <div class="card evidence">
          <h3>Evidence</h3>
          {p.excerpt ? <blockquote>{p.excerpt}</blockquote> : null}
          {safeHref(p.evidence_url) ? (
            <a
              href={p.evidence_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {p.evidence_url}
            </a>
          ) : (
            <span class="muted">{p.evidence_url}</span>
          )}
        </div>
        <div class="card">
          <h3>
            Patches — {p.patches.length} op{p.patches.length === 1 ? "" : "s"}
          </h3>
          {p.patches.map(patchCard)}
        </div>
        {pending ? (
          <div class="card">
            <h3>Decision</h3>
            <div class="actions">
              <input
                type="text"
                id="note"
                ref={noteRef}
                placeholder="Decision note (required to reject)"
              />
              <button class="btn reject" id="reject" onClick={onReject}>
                Reject
              </button>
              <button class="btn approve" id="approve" onClick={onApprove}>
                Approve & apply
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  if (loadError) {
    return <div class="empty">Failed to load: {loadError}</div>;
  }

  let body: ComponentChildren;
  if (detail !== null || detailBusy) {
    body = detailView();
  } else if (tab === "queue") {
    body = (
      <>
        <h2 class="page-title">Pending proposals</h2>
        <p class="page-sub">
          Submitted via /maintainer — approve applies the patches to D1 in one
          transaction.
        </p>
        {listTable(queue, false)}
      </>
    );
  } else if (tab === "history") {
    body = (
      <>
        <h2 class="page-title">Decision history</h2>
        <p class="page-sub">
          Audit trail — who proposed, what changed, who decided.
        </p>
        {listTable(decided, true)}
      </>
    );
  } else {
    body = (
      <>
        <h2 class="page-title">Quarantined reports</h2>
        <p class="page-sub">
          Public submissions via report_issue — triage leads for the maintenance
          agent.
        </p>
        {reportsTable()}
      </>
    );
  }

  return (
    <>
      <div class="topbar">
        <div class="brand">
          <span class="dot"></span>Cardex Admin
        </div>
        <div class="tabs">
          <button
            class={
              "tab" + (tab === "queue" && !detail && !detailBusy ? " active" : "")
            }
            onClick={() => {
              setTab("queue");
              setDetail(null);
            }}
          >
            Queue <span class="badge">{queue.length}</span>
          </button>
          <button
            class={"tab" + (tab === "history" ? " active" : "")}
            onClick={() => {
              setTab("history");
              setDetail(null);
            }}
          >
            History
          </button>
          <button
            class={"tab" + (tab === "reports" ? " active" : "")}
            onClick={() => {
              setTab("reports");
              setDetail(null);
            }}
          >
            Reports
          </button>
        </div>
        <div class="who">
          <span class="access">ACCESS</span>
          <span>{me}</span>
        </div>
      </div>
      <div class="main">{body}</div>
      {confirm ? (
        <div class="modal-backdrop">
          <div class="modal">
            <h3>
              Apply {confirm.patches} patch{confirm.patches === 1 ? "" : "es"}?
            </h3>
            <p>
              This writes to the facts tables in one transaction and marks{" "}
              {confirm.id} applied.
            </p>
            {pinRequired ? (
              <div class="pin-row">
                <label>Approval PIN</label>
                <input
                  id="pin"
                  type="password"
                  autocomplete="off"
                  ref={pinRef}
                />
              </div>
            ) : null}
            <div class="modal-btns">
              <button class="btn" id="cancel" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                class="btn approve"
                id="confirm"
                ref={confirmBtnRef}
                onClick={onConfirmApply}
              >
                Confirm apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toastMsg ? <div class="toast">{toastMsg}</div> : null}
    </>
  );
}
