"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { IDLE, type FormState } from "@/lib/form-state";
import { Notice } from "./Notice";

/**
 * A form bound to a server action `(prev, formData) => Promise<FormState>` (see
 * `runAction`). Shows the returned message above the fields and disables them while the
 * action runs. Works before hydration (progressive enhancement).
 */
export function ActionForm({
  action,
  children,
  className = "",
  confirmMessage,
  preserveValues = false,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  /** Layout of the fields (applied to the fieldset that wraps them, below the result message). */
  className?: string;
  /** Asks for confirmation before submitting (destructive actions). */
  confirmMessage?: string;
  /**
   * Keep what the user typed after the action returns (React resets uncontrolled fields after
   * a form action by default). Use for long forms where an error asks for a correction.
   */
  preserveValues?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const onSubmit =
    confirmMessage || preserveValues
      ? (event: FormEvent<HTMLFormElement>) => {
          if (confirmMessage && !window.confirm(confirmMessage)) {
            event.preventDefault();
            return;
          }
          if (preserveValues) {
            event.preventDefault();
            const submitter = (event.nativeEvent as SubmitEvent).submitter;
            const formData = new FormData(event.currentTarget, submitter);
            startTransition(() => formAction(formData));
          }
        }
      : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit}>
      {state.message ? (
        <div className="mb-4">
          <Notice tone={state.status === "error" ? "error" : "success"}>{state.message}</Notice>
        </div>
      ) : null}
      {/* Layout classes go on the fieldset: `space-y-*` on the form would only space the fieldset itself. */}
      <fieldset disabled={pending} className={`min-w-0 ${className}`}>
        {children}
      </fieldset>
    </form>
  );
}
