/** What a server action returns to `<ActionForm>`. `message` is shown to the user. */
export interface FormState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export const IDLE: FormState = { status: "idle" };
