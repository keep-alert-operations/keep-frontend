"use client";
import { message } from "@/lib/api";

export function ErrorNotice({ error, id }: { error?: unknown; id?: string }) {
  return error ? (
    <div id={id} role="alert" className="notice error">
      {message(error)}
    </div>
  ) : null;
}
export function CommandFeedback({
  command,
}: {
  command: { error?: unknown; uncertain: boolean; busy: boolean };
}) {
  return (
    <>
      <ErrorNotice error={command.error} />
      {command.uncertain && (
        <p className="notice" role="status">
          The outcome is uncertain. Retry repeats the original command and
          values. Your draft remains in this tab.
        </p>
      )}
      {command.busy && <p role="status">Saving…</p>}
    </>
  );
}
