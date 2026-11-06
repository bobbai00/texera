import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./utils";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** What the list says about the option besides its label; the trigger shows the label alone. */
  hint?: string;
}

/** A single-choice popup select over Base UI. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: T | null;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={v => v !== null && onChange(v as T)}
      disabled={disabled}
      // The trigger shows the chosen option's label, not its raw value.
      items={options.map(o => ({ value: o.value, label: o.label }))}>
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "control focus-ring inline-flex h-8 items-center justify-between gap-2 px-2.5 text-xs data-[popup-open]:border-ring",
          className
        )}>
        <BaseSelect.Value placeholder={placeholder} className="truncate" />
        <BaseSelect.Icon className="shrink-0 text-muted-foreground">
          <ChevronDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} className="z-50">
          <BaseSelect.Popup className="max-h-72 min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            {options.map(o => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                // The option is named by its label; the hint describes it.
                aria-label={o.label}
                aria-description={o.hint}
                className="flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent">
                <BaseSelect.ItemIndicator className="w-3.5">
                  <Check className="size-3.5" />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText className="truncate">{o.label}</BaseSelect.ItemText>
                {o.hint && <span className="ml-auto shrink-0 pl-3 text-muted-foreground">{o.hint}</span>}
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
