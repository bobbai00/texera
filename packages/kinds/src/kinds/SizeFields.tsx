import { Field, NativeSelect } from "@texera/ui";
import { useId } from "react";
import { CPU_CHOICES, GPU_CHOICES, MEMORY_CHOICES, type Makeup } from "./profiles";

type Choice = { value: string; label: string };

/** The choices, and the value set when it is none of them, as it is. */
const withCurrent = (choices: Choice[], value: string): Choice[] =>
  choices.some(c => c.value === value) ? choices : [...choices, { value, label: value || "Default" }];

/**
 * What a node reserves on the cluster: memory, CPU and GPUs, each a choice. It changes only the
 * size of the makeup it is given; what is left at none reserves nothing of its own.
 */
export function SizeFields({
  makeup,
  onChange,
  disabled,
}: {
  makeup: Makeup;
  onChange: (makeup: Makeup) => void;
  disabled?: boolean;
}) {
  const ids = { memory: useId(), cpu: useId(), gpu: useId() };
  const set = (field: "memory" | "cpu" | "gpu", value: string) => {
    const { [field]: _, ...rest } = makeup;
    onChange(value ? { ...rest, [field]: field === "gpu" ? Number(value) : value } : rest);
  };
  const fields = [
    { field: "memory" as const, label: "Memory", choices: MEMORY_CHOICES, value: makeup.memory ?? "" },
    { field: "cpu" as const, label: "CPU", choices: CPU_CHOICES, value: makeup.cpu ?? "" },
    { field: "gpu" as const, label: "GPU", choices: GPU_CHOICES, value: makeup.gpu ? String(makeup.gpu) : "" },
  ];
  return (
    <div className="grid grid-cols-3 gap-3" data-unit-size>
      {fields.map(f => (
        <Field key={f.field} label={f.label} htmlFor={ids[f.field]}>
          <NativeSelect
            id={ids[f.field]}
            value={f.value}
            onChange={e => set(f.field, e.target.value)}
            disabled={disabled}
            className="w-full"
            data-field={f.field}>
            {withCurrent(f.choices, f.value).map(c => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ))}
    </div>
  );
}
