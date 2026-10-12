"use client";

import type { Preset } from "@fireround/core";
import { STAGES } from "@fireround/core/client";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { createPreset, type PresetInput, updatePreset } from "@/app/(dashboard)/presets/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { stageLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/** The monitor goal a new preset starts from; it names the chosen stages so the judge has something to hold against. */
export function goalTemplate(stages: string[]): string {
  const named = stages.length > 0 ? stages.map((s) => stageLabel(s).toLowerCase()).join(", ") : "matching";
  return `Alert when a startup announces a new ${named} funding round. Ignore other stages, debt facilities, grants, funds raised by venture firms, rounds that are only rumored or in talks and not yet closed, and opinion or analysis pieces that do not report a specific new round.`;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** One list-shaped field: the eyebrow carries the constraint, the textarea takes one item a line. */
function Lines({
  id,
  eyebrow,
  hint,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  id: string;
  eyebrow: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex-wrap gap-x-1.5 gap-y-1">
        <Tag>{eyebrow}</Tag>
        {hint && <span className={cn("text-label-x-small font-normal", SECONDARY)}>{hint}</span>}
      </Label>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-mono-small"
      />
    </div>
  );
}

interface FormState {
  name: string;
  description: string;
  stages: string[];
  queries: string;
  goal: string;
  xAccounts: string;
  watchSites: string;
}

function initialState(preset?: Preset): FormState {
  return {
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    stages: preset?.stages ?? [],
    queries: preset?.queries.join("\n") ?? "",
    goal: preset?.goal ?? goalTemplate([]),
    xAccounts: preset?.xAccounts.join("\n") ?? "",
    watchSites: preset?.watchSites.join("\n") ?? "",
  };
}

/**
 * Create (no `preset`) or edit (with one) a custom preset. Server-side zod is the validator; the
 * form just shapes the textareas into arrays and shows what came back. Pass `open` and
 * `onOpenChange` instead of a trigger when something else opens it, like the card's overflow menu.
 */
export function PresetDialog({
  preset,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  preset?: Preset;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [state, setState] = useState<FormState>(() => initialState(preset));
  // Until the operator edits the goal, it follows the stages; after that it is theirs.
  const [goalTouched, setGoalTouched] = useState(Boolean(preset));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const toggleStage = (stage: string) => {
    const stages = state.stages.includes(stage) ? state.stages.filter((s) => s !== stage) : [...state.stages, stage];
    setState((s) => ({ ...s, stages, goal: goalTouched ? s.goal : goalTemplate(stages) }));
  };
  const reset = () => {
    setState(initialState(preset));
    setGoalTouched(Boolean(preset));
    setError(null);
  };

  const submit = () =>
    start(async () => {
      const input: PresetInput = {
        name: state.name.trim(),
        description: state.description.trim(),
        stages: state.stages,
        queries: lines(state.queries),
        goal: state.goal.trim(),
        xAccounts: lines(state.xAccounts).map((h) => h.replace(/^@/, "")),
        watchSites: lines(state.watchSites),
      };
      const result = preset ? await updatePreset(preset.slug, input) : await createPreset(input);
      if (result.ok) {
        setOpen(false);
        reset();
        toast.success(preset ? "Preset saved" : "Preset created", { description: input.name });
      } else {
        setError(result.error);
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{preset ? `Edit ${preset.name}` : "New preset"}</DialogTitle>
          <DialogDescription>
            Queries control recall, the goal controls what the monitor alerts on, stages control what the feed keeps.
            {preset && (
              <>
                {" "}
                Slug <code className="font-mono">{preset.slug}</code> stays; rounds and the monitor hang off it.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="preset-name">
              <Tag>name</Tag>
            </Label>
            <Input
              id="preset-name"
              required
              value={state.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Series C and later"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preset-description">
              <Tag>description</Tag>
            </Label>
            <Input
              id="preset-description"
              required
              value={state.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Companies that just announced a Series C or later round."
            />
          </div>

          <fieldset className="space-y-1.5">
            <legend className="flex items-center gap-1.5">
              <Tag>stages</Tag>
              <span className={cn("text-label-x-small font-normal", SECONDARY)}>at least one</span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map((s) => {
                const on = state.stages.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleStage(s)}
                    className={cn(
                      "inline-flex h-6 items-center rounded-4xl border px-2.5 text-label-x-small transition-colors",
                      on ? "border-heat-40 bg-heat-4 text-heat-ink" : cn("border-border hover:bg-muted", SECONDARY),
                    )}
                  >
                    {stageLabel(s)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <Lines
            id="preset-queries"
            eyebrow="queries · recall"
            hint="one a line, 1 to 12"
            value={state.queries}
            onChange={(v) => set("queries", v)}
            placeholder={'startup "raises Series C" million'}
            rows={5}
          />
          <div className="space-y-1.5">
            <Label htmlFor="preset-goal">
              <Tag>goal · precision</Tag>
            </Label>
            <Textarea
              id="preset-goal"
              rows={4}
              value={state.goal}
              onChange={(e) => {
                setGoalTouched(true);
                set("goal", e.target.value);
              }}
              className="text-body-small"
            />
          </div>
          <Lines
            id="preset-x-accounts"
            eyebrow="X accounts · timelines"
            hint="optional, handles, up to 10"
            value={state.xAccounts}
            onChange={(v) => set("xAccounts", v)}
            placeholder="crunchbasenews"
            rows={2}
          />
          <Lines
            id="preset-watch-sites"
            eyebrow="watch sites · sections"
            hint="optional, section URLs, up to 20"
            value={state.watchSites}
            onChange={(v) => set("watchSites", v)}
            placeholder="https://techcrunch.com/category/venture/"
            rows={2}
          />

          {error && <p className="text-body-small text-crimson-ink">{error}</p>}

          <DialogFooter className="mt-4 items-center">
            {!preset && (
              <span className={cn("text-label-x-small font-normal sm:mr-auto", SECONDARY)}>Slug and order are set from the name.</span>
            )}
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || state.stages.length === 0}>
              {preset ? "Save changes" : "Create preset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
