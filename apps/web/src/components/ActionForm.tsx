"use client";

import { useActionState, type FormEvent, type ReactNode } from "react";
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
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  /** Asks for confirmation before submitting (destructive actions). */
  confirmMessage?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const onSubmit = confirmMessage
    ? (event: FormEvent<HTMLFormElement>) => {
        if (!window.confirm(confirmMessage)) event.preventDefault();
      }
    : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit} className={className}>
      {state.message ? (
        <div className="mb-4">
          <Notice tone={state.status === "error" ? "error" : "success"}>{state.message}</Notice>
        </div>
      ) : null}
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
