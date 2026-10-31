// Three visual directions for the /admin review surface, same markup,
// different token sheets — A quiet light, B dark ops console, C warm ledger.

const sharedCss = `
  .surf { font-size: 13px; line-height: 1.45; height: 100%; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text); font-family: var(--sans); }
  .surf .topbar { display: flex; align-items: center; gap: 16px; padding: 0 18px; height: 46px;
    background: var(--surface); border-bottom: 1px solid var(--border); }
  .surf .brand { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 7px; }
  .surf .brand i { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); font-style: normal; }
  .surf .tabs { display: flex; gap: 3px; flex: 1; }
  .surf .tab { padding: 4px 10px; border-radius: 6px; font-size: 12px; color: var(--dim); }
  .surf .tab.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
  .surf .tab .badge { background: var(--pending-bg); color: var(--pending); border-radius: 9px;
    font-size: 10px; padding: 0 6px; margin-left: 4px; font-weight: 600; }
  .surf .who { font-family: var(--mono); font-size: 11px; color: var(--dim); display: flex; gap: 7px; align-items: center; }
  .surf .who .acc { font-size: 9px; letter-spacing: .4px; color: var(--success);
    border: 1px solid var(--success); border-radius: 9px; padding: 1px 6px; }
  .surf .body { padding: 16px 18px; overflow: hidden; }
  .surf h4 { margin: 0 0 2px; font-size: 15px; font-family: var(--head, var(--sans)); }
  .surf .sub { margin: 0 0 14px; font-size: 12px; color: var(--dim); }
  .surf .rows { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .surf .row { display: grid; grid-template-columns: 1fr 70px 60px 70px; gap: 10px; align-items: center;
    padding: 9px 12px; border-bottom: 1px solid var(--soft); }
  .surf .row:last-child { border-bottom: none; }
  .surf .row .name { font-weight: 500; }
  .surf .row .id { font-family: var(--mono); font-size: 11px; color: var(--faint); }
  .surf .row .ops, .surf .row .age { font-family: var(--mono); font-size: 11px; color: var(--dim); text-align: right; }
  .surf .chip { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 9px; justify-self: end; }
  .surf .chip.pending { background: var(--pending-bg); color: var(--pending); }
  .surf .patch { margin-top: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .surf .patch-head { display: flex; gap: 9px; align-items: center; padding: 7px 11px;
    background: var(--headbg); border-bottom: 1px solid var(--soft); font-family: var(--mono); font-size: 11px; }
  .surf .patch-head .chip.upd { background: var(--pending-bg); color: var(--pending); }
  .surf .patch-head .tid { color: var(--accent); }
  .surf .drow { display: grid; grid-template-columns: 120px 1fr 22px 1fr; gap: 9px; align-items: center;
    padding: 5px 11px; font-family: var(--mono); font-size: 11px; }
  .surf .drow .f { color: var(--dim); }
  .surf .drow .o { background: var(--danger-bg); color: var(--danger); border-radius: 4px; padding: 1px 6px; }
  .surf .drow .n { background: var(--success-bg); color: var(--success); border-radius: 4px; padding: 1px 6px; }
  .surf .drow .a { color: var(--faint); text-align: center; }
`;

const dirA = `
  .dir-a { --bg: hsl(210,16%,96%); --surface: hsl(0,0%,100%); --border: hsl(213,14%,84%);
    --soft: hsl(213,14%,91%); --headbg: hsl(210,16%,96%);
    --text: hsl(215,14%,15%); --dim: hsl(215,10%,42%); --faint: hsl(215,9%,58%);
    --accent: hsl(212,45%,40%); --accent-bg: hsl(212,38%,94%);
    --success: hsl(148,40%,30%); --success-bg: hsl(148,30%,93%);
    --danger: hsl(4,48%,42%); --danger-bg: hsl(6,40%,95%);
    --pending: hsl(36,45%,32%); --pending-bg: hsl(42,45%,93%);
    --sans: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, monospace; }
`;

const dirB = `
  .dir-b { --bg: hsl(222,42%,8%); --surface: hsl(220,30%,13%); --border: hsl(218,20%,25%);
    --soft: hsl(218,18%,20%); --headbg: hsl(220,28%,16%);
    --text: hsl(214,32%,92%); --dim: hsl(216,15%,64%); --faint: hsl(216,12%,46%);
    --accent: hsl(210,65%,66%); --accent-bg: hsl(215,40%,22%);
    --success: hsl(150,45%,60%); --success-bg: hsl(150,38%,15%);
    --danger: hsl(6,62%,66%); --danger-bg: hsl(6,42%,18%);
    --pending: hsl(38,58%,60%); --pending-bg: hsl(40,38%,17%);
    --sans: "Fira Sans", -apple-system, sans-serif;
    --mono: "Fira Code", ui-monospace, Menlo, monospace; }
`;

const dirC = `
  .dir-c { --bg: hsl(42,24%,93%); --surface: hsl(46,32%,98%); --border: hsl(38,16%,80%);
    --soft: hsl(40,16%,88%); --headbg: hsl(42,24%,90%);
    --text: hsl(26,14%,16%); --dim: hsl(30,9%,40%); --faint: hsl(32,8%,56%);
    --accent: hsl(16,48%,42%); --accent-bg: hsl(20,42%,91%);
    --success: hsl(105,32%,30%); --success-bg: hsl(100,26%,90%);
    --danger: hsl(8,48%,42%); --danger-bg: hsl(10,42%,94%);
    --pending: hsl(35,50%,33%); --pending-bg: hsl(44,48%,90%);
    --sans: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --head: Georgia, "Times New Roman", serif;
    --mono: ui-monospace, "SF Mono", Menlo, monospace; }
`;

function Surface({ cls }) {
  return (
    <div className={"surf " + cls}>
      <div className="topbar">
        <div className="brand"><i></i>Cardex Admin</div>
        <div className="tabs">
          <span className="tab on">Queue<span className="badge">3</span></span>
          <span className="tab">History</span>
          <span className="tab">Reports</span>
        </div>
        <div className="who"><span className="acc">ACCESS</span>brandon@cardex.dev</div>
      </div>
      <div className="body">
        <h4>Pending proposals</h4>
        <p className="sub">Submitted by grokbot via /maintainer</p>
        <div className="rows">
          <div className="row">
            <div><div className="name">New Mox merchant cashback promo — 3% Nov–Dec</div><div className="id">prop-0044 · grokbot</div></div>
            <div className="ops">4 ops</div><div className="age">2h ago</div><div><span className="chip pending">pending</span></div>
          </div>
          <div className="row">
            <div><div className="name">HSBC Red merchant whitelist adds KFC</div><div className="id">prop-0043 · grokbot</div></div>
            <div className="ops">2 ops</div><div className="age">4h ago</div><div><span className="chip pending">pending</span></div>
          </div>
          <div className="row">
            <div><div className="name">DBS Black MC dining quota 10,000 → 15,000</div><div className="id">prop-0042 · grokbot</div></div>
            <div className="ops">1 op</div><div className="age">14h ago</div><div><span className="chip pending">pending</span></div>
          </div>
        </div>
        <div className="patch">
          <div className="patch-head"><span className="chip upd">UPDATE</span><span>terms</span><span className="tid">term_dbs_quota</span></div>
          <div className="drow"><span className="f">quota_n</span><span className="o">10000</span><span className="a">→</span><span className="n">15000</span></div>
          <div className="drow"><span className="f">last_verified_at</span><span className="o">2026-10-20</span><span className="a">→</span><span className="n">2026-11-01</span></div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <div>
      <style>{sharedCss + dirA + dirB + dirC}</style>
      <DesignCanvas>
        <DCSection id="directions" title="Cardex Admin — review surface" subtitle="Same content, three visual languages">
          <DCArtboard id="a" label="A · Quiet Review (current)" width={860} height={560}>
            <Surface cls="dir-a" />
          </DCArtboard>
          <DCArtboard id="b" label="B · Ops Console (dark)" width={860} height={560}>
            <Surface cls="dir-b" />
          </DCArtboard>
          <DCArtboard id="c" label="C · Ledger (warm)" width={860} height={560}>
            <Surface cls="dir-c" />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
