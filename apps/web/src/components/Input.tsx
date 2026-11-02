import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const FIELD =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-500";

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
}

function Field({ id, label, hint, children }: FieldProps & { id?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      {label ? (
        <label htmlFor={id} className="block text-sm font-medium text-zinc-800">
          {label}
        </label>
      ) : null}
      {children}
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;

/** Text-like input with an optional label and hint. `id` defaults to `name`. */
export function Input({ label, hint, id, name, className = "", ...props }: InputProps) {
  const inputId = id ?? name;
  return (
    <Field id={inputId} label={label} hint={hint}>
      <input id={inputId} name={name} className={`${FIELD} ${className}`} {...props} />
    </Field>
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldProps;

export function Select({ label, hint, id, name, className = "", children, ...props }: SelectProps) {
  const selectId = id ?? name;
  return (
    <Field id={selectId} label={label} hint={hint}>
      <select id={selectId} name={name} className={`${FIELD} ${className}`} {...props}>
        {children}
      </select>
    </Field>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & FieldProps;

export function Checkbox({ label, hint, id, name, className = "", ...props }: CheckboxProps) {
  const inputId = id ?? name;
  return (
    <div className="flex items-start gap-2">
      <input
        id={inputId}
        name={name}
        type="checkbox"
        className={`mt-0.5 size-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 disabled:opacity-60 ${className}`}
        {...props}
      />
      <div>
        {label ? (
          <label htmlFor={inputId} className="block text-sm font-medium text-zinc-800">
            {label}
          </label>
        ) : null}
        {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
      </div>
    </div>
  );
}
