const { useState } = React;

const OWNER_EMAIL = "brandon@cardex.dev";

function StatusChip({ status }) {
  return <span className={"chip " + status}>{status}</span>;
}

function PatchView({ patch }) {
  const current = lookupFact(patch.table, patch.id);
  const rows = Object.entries(patch.set);
  return (
    <div className="patch">
      <div className="patch-head">
        <span className={"chip op-" + patch.op}>{patch.op.toUpperCase()}</span>
        <span className="mono">{patch.table}</span>
        <span className="target">{patch.id}</span>
      </div>
      <div className="patch-rows">
        {patch.op === "update" && rows.map(([k, v]) => (
          <div className="diff-row" key={k}>
            <span className="field">{k}</span>
            <span className="old">{current && current[k] !== undefined ? String(current[k]) : "∅"}</span>
            <span className="arrow">→</span>
            <span className="new">{String(v)}</span>
          </div>
        ))}
        {patch.op === "insert" && rows.map(([k, v]) => (
          <div className="diff-row" key={k}>
            <span className="field">{k}</span>
            <span className="ins">+ {String(v)}</span>
          </div>
        ))}
        {patch.op === "delete" && rows.map(([k, v]) => (
          <div className="diff-row" key={k}>
            <span className="field">{k}</span>
            <span className="del">− {String(v)}</span>
          </div>
        ))}
        {patch.op === "delete" && rows.length === 0 && (
          <div className="diff-row"><span className="field"></span><span className="del">delete row {patch.id}</span></div>
        )}
      </div>
    </div>
  );
}

function ProposalDetail({ proposal, readOnly, onBack, onApproveAsk, onReject }) {
  const [note, setNote] = useState("");
  const rejectNeedsNote = note.trim() === "";
  return (
    <div data-screen-label="Proposal detail">
      <button className="back-link" onClick={onBack}>← Back to queue</button>
      <div className="detail-grid">
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span className="mono faint">{proposal.id}</span>
            <StatusChip status={proposal.status} />
            <span className="faint">by {proposal.proposed_by} · {fmtAge(proposal.created_at)}</span>
          </div>
          <div className="page-title" style={{ fontSize: 16 }}>{proposal.summary}</div>
        </div>

        <div className="card evidence">
          <h3>Evidence</h3>
          <blockquote>{proposal.excerpt}</blockquote>
          <a href={proposal.evidence_url} target="_blank" rel="noreferrer">{proposal.evidence_url}</a>
        </div>

        <div className="card">
          <h3>Patches — {proposal.patches.length} op{proposal.patches.length > 1 ? "s" : ""}</h3>
          {proposal.patches.map((p, i) => <PatchView key={i} patch={p} />)}
          {readOnly && proposal.decision_note && (
            <p className="muted" style={{ marginTop: 10 }}>Decision note: {proposal.decision_note}</p>
          )}
          {readOnly && (
            <p className="faint">Decided by {proposal.decided_by} · {fmtTs(proposal.decided_at)}</p>
          )}
        </div>

        {!readOnly && (
          <div className="card">
            <h3>Decision</h3>
            <div className="actions">
              <input
                type="text"
                placeholder="Decision note (required to reject)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="btn reject" disabled={rejectNeedsNote} onClick={() => onReject(note)}>Reject</button>
              <button className="btn approve" onClick={onApproveAsk}>Approve &amp; apply</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QueueTable({ proposals, onOpen }) {
  if (proposals.length === 0) {
    return <div className="card empty">No pending proposals. Grokbot will file them here via /maintainer.</div>;
  }
  return (
    <table className="list">
      <thead>
        <tr><th>Proposal</th><th>Patches</th><th>Evidence</th><th>Proposed</th><th>Status</th></tr>
      </thead>
      <tbody>
        {proposals.map((p) => (
          <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
            <td>
              <div style={{ fontWeight: 500 }}>{p.summary}</div>
              <div className="faint mono">{p.id} · by {p.proposed_by}</div>
            </td>
            <td className="mono">{p.patches.length} op{p.patches.length > 1 ? "s" : ""}</td>
            <td><a className="mono" href={p.evidence_url} onClick={(e) => e.stopPropagation()} target="_blank" rel="noreferrer">link ↗</a></td>
            <td className="faint">{fmtAge(p.created_at)}</td>
            <td><StatusChip status={p.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTable({ proposals, onOpen }) {
  return (
    <table className="list">
      <thead>
        <tr><th>Proposal</th><th>Decided</th><th>By</th><th>Note</th><th>Status</th></tr>
      </thead>
      <tbody>
        {proposals.map((p) => (
          <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
            <td>
              <div style={{ fontWeight: 500 }}>{p.summary}</div>
              <div className="faint mono">{p.id}</div>
            </td>
            <td className="faint">{fmtTs(p.decided_at)}</td>
            <td className="mono">{p.decided_by}</td>
            <td className="muted">{p.decision_note || "—"}</td>
            <td><StatusChip status={p.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportsTable({ reports, total = reports.length }) {
  const exportReports = () => {
    const blob = new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cardex-reports-${localDate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      <p className="page-sub">Public submissions via <span className="mono">report_issue</span> — owner-triaged leads; the maintenance agent never sees them.</p>
      {reports.length > 0 && (
        <div className="toolbar">
          <button className="btn" onClick={exportReports}>Export JSON</button>
          {total > reports.length && (
            <span className="faint" style={{ marginLeft: 10 }}>Showing newest {reports.length} of {total}</span>
          )}
        </div>
      )}
      <table className="list">
        <thead>
          <tr><th>Target</th><th>Field</th><th>Claimed value</th><th>Evidence</th><th>Note</th><th>Reported</th></tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id} className={r.evidence_url ? "" : "dim-row"}>
              <td><span className="target">{r.target_kind}/{r.target_id}</span></td>
              <td className="mono">{r.field}</td>
              <td className="mono">{r.claimed_value}</td>
              <td>{r.evidence_url ? <a className="mono" href={r.evidence_url} target="_blank" rel="noreferrer">link ↗</a> : <span className="faint">none</span>}</td>
              <td className="muted">{r.note || "—"}</td>
              <td className="faint">{fmtTs(r.reported_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfirmModal({ proposal, onCancel, onConfirm }) {
  const [pin, setPin] = useState("");
  const tables = [...new Set(proposal.patches.map((p) => p.table))].join(", ");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Apply {proposal.patches.length} patch{proposal.patches.length > 1 ? "es" : ""}?</h3>
        <p>
          This writes to <span className="mono">{tables}</span> in D1 immediately.
          The proposal is marked <span className="mono">applied</span> with your email as <span className="mono">decided_by</span>.
        </p>
        <div className="pin-row">
          <label>PIN — optional second factor (ADR 0002)</label>
          <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" />
        </div>
        <div className="modal-btns">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn approve" onClick={() => onConfirm(pin)}>Confirm apply</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState("queue");
  const [proposals, setProposals] = useState(PROPOSALS);
  const [selectedId, setSelectedId] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [toast, setToast] = useState(null);

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals
    .filter((p) => p.status !== "pending")
    .sort((a, b) => (b.decided_at || "").localeCompare(a.decided_at || ""));
  const selected = proposals.find((p) => p.id === selectedId);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const decide = (id, status, note) => {
    setProposals((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, status, decided_at: "2026-11-01T12:05:00Z", decided_by: OWNER_EMAIL, decision_note: note || "" }
          : p
      )
    );
  };

  const doApprove = (pin) => {
    decide(confirming.id, "applied", "");
    setConfirming(null);
    setSelectedId(null);
    showToast(`Applied ${confirming.id} — patches written to facts`);
  };

  const doReject = (note) => {
    decide(selected.id, "rejected", note);
    setSelectedId(null);
    showToast(`Rejected ${selected.id}`);
  };

  return (
    <div>
      <div className="topbar">
        <div className="brand"><span className="dot"></span>Cardex Admin</div>
        <div className="tabs">
          <button className={"tab" + (tab === "queue" ? " active" : "")} onClick={() => { setTab("queue"); setSelectedId(null); }}>
            Queue {pending.length > 0 && <span className="badge">{pending.length}</span>}
          </button>
          <button className={"tab" + (tab === "history" ? " active" : "")} onClick={() => { setTab("history"); setSelectedId(null); }}>History</button>
          <button className={"tab" + (tab === "reports" ? " active" : "")} onClick={() => { setTab("reports"); setSelectedId(null); }}>Reports</button>
        </div>
        <div className="who"><span className="access">ACCESS</span>{OWNER_EMAIL}</div>
      </div>

      <div className="main">
        {selected ? (
          <ProposalDetail
            proposal={selected}
            readOnly={selected.status !== "pending"}
            onBack={() => setSelectedId(null)}
            onApproveAsk={() => setConfirming(selected)}
            onReject={doReject}
          />
        ) : tab === "queue" ? (
          <div data-screen-label="Queue">
            <h2 className="page-title">Pending proposals</h2>
            <p className="page-sub">Submitted by grokbot via <span className="mono">/maintainer</span> — approve applies the patches to D1 in one transaction.</p>
            <QueueTable proposals={pending} onOpen={setSelectedId} />
          </div>
        ) : tab === "history" ? (
          <div data-screen-label="History">
            <h2 className="page-title">Decision history</h2>
            <p className="page-sub">The audit trail — who decided what, when, and why.</p>
            <HistoryTable proposals={decided} onOpen={setSelectedId} />
          </div>
        ) : (
          <div data-screen-label="Reports">
            <h2 className="page-title">Reports quarantine</h2>
            <ReportsTable reports={REPORTS} />
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmModal
          proposal={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={doApprove}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
