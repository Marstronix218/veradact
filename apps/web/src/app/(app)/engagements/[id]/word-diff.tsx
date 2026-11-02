import { wordDiff } from "@veradact/core";

/** Word-level diff of two statements (server component): deletions struck through, insertions highlighted. */
export function WordDiff({ before, after }: { before: string; after: string }) {
  return (
    <p className="text-sm leading-relaxed text-zinc-800" data-testid="word-diff">
      {wordDiff(before, after).map((segment, i) =>
        segment.op === "equal" ? (
          <span key={i}>{segment.text}</span>
        ) : segment.op === "delete" ? (
          <del key={i} className="bg-red-50 text-red-800 decoration-red-400">
            {segment.text}
          </del>
        ) : (
          <ins key={i} className="bg-green-50 text-green-800 no-underline">
            {segment.text}
          </ins>
        ),
      )}
    </p>
  );
}
