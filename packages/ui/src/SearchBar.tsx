import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@pines/shared";
import { api } from "./api";

export function SearchBar({
  onResults,
  onPick,
}: {
  /** Called with results (or null when the query is cleared) for spotlighting. */
  onResults: (results: SearchResult[] | null) => void;
  onPick: (treeId: string, nodeId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      onResults(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          setResults(r);
          setOpen(true);
          onResults(r);
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" focuses search unless typing elsewhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (e.key === "/" && tag !== "input" && tag !== "textarea") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clear = () => {
    setQuery("");
    setOpen(false);
    onResults(null);
    inputRef.current?.blur();
  };

  return (
    <div className="searchbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="search the forest…  ( / )"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            clear();
          }
          if (e.key === "Enter" && results.length > 0) {
            const r = results[0];
            onPick(r.treeId, r.matches[0]?.nodeId);
            clear();
          }
        }}
      />
      {open && results.length > 0 && (
        <div className="searchresults" onMouseLeave={() => setOpen(false)}>
          {results.map((r) => (
            <div key={r.treeId} className="searchresult">
              <div
                className="searchresult-title"
                onClick={() => {
                  onPick(r.treeId, r.matches[0]?.nodeId);
                  clear();
                }}
              >
                <span className={`dot dot-${r.status}`} /> {r.title}
                <span className="searchresult-score">{r.score}</span>
              </div>
              {r.matches.map((m) => (
                <div
                  key={m.nodeId}
                  className="searchresult-match"
                  onClick={() => {
                    onPick(r.treeId, m.nodeId);
                    clear();
                  }}
                >
                  <span className="searchresult-role">{m.role ?? "·"}</span> {m.preview}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {query && !open && (
        <button className="linkbtn" onClick={clear}>
          clear
        </button>
      )}
    </div>
  );
}
