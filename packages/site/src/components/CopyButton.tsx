import { useEffect, useState } from "preact/hooks";

interface Props {
  text: string;
  label: string;
  copied: string;
  failed: string;
}

type State = "idle" | "success" | "error";

export default function CopyButton({ text, label, copied, failed }: Props) {
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("success");
    } catch {
      setState("error");
    }
  };

  return (
    <button
      class="btn-copy"
      type="button"
      onClick={copy}
      data-state={state === "idle" ? undefined : state}
      aria-live="polite"
    >
      {state === "success" ? copied : state === "error" ? failed : label}
    </button>
  );
}
