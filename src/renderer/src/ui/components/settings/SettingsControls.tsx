import { useId, type ReactElement, type ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SettingsCard({
  title,
  description,
  children,
}: SettingsCardProps): ReactElement {
  return (
    <section className="ds-settings-card">
      <header className="ds-settings-card-header">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      <div className="ds-settings-card-body">{children}</div>
    </section>
  );
}

interface SettingRowProps {
  title: string;
  description?: string;
  control: ReactNode;
  controlId?: string;
  wide?: boolean;
}

export function SettingRow({
  title,
  description,
  control,
  controlId,
  wide = false,
}: SettingRowProps): ReactElement {
  const descriptionId = useId();
  return (
    <div className={`ds-setting-row${wide ? " is-wide" : ""}`}>
      <div className="ds-setting-row-copy">
        {controlId ? (
          <label className="ds-setting-row-title" htmlFor={controlId}>
            {title}
          </label>
        ) : (
          <div className="ds-setting-row-title">{title}</div>
        )}
        {description ? <p id={descriptionId}>{description}</p> : null}
      </div>
      <div className="ds-setting-row-control">{control}</div>
    </div>
  );
}

interface SecretInputProps {
  id: string;
  value: string;
  visible: boolean;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  onChange(value: string): void;
  onToggleVisibility(): void;
}

export function SecretInput({
  id,
  value,
  visible,
  placeholder,
  autoComplete,
  disabled = false,
  showLabel,
  hideLabel,
  onChange,
  onToggleVisibility,
}: SecretInputProps): ReactElement {
  const label = visible ? hideLabel : showLabel;

  return (
    <div className="ds-secret-input">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onToggleVisibility}
      >
        {label}
      </button>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

export function Toggle({
  checked,
  label,
  disabled = false,
  onChange,
}: ToggleProps): ReactElement {
  return (
    <button
      type="button"
      className={`ds-settings-toggle-switch${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

interface StatusBadgeProps {
  tone: "idle" | "dirty" | "saving" | "saved" | "error" | "loading";
  children: ReactNode;
  title?: string;
}

export function StatusBadge({
  tone,
  children,
  title,
}: StatusBadgeProps): ReactElement {
  return (
    <span
      className={`ds-settings-status-badge is-${tone}`}
      role="status"
      aria-live="polite"
      title={title}
    >
      {children}
    </span>
  );
}
