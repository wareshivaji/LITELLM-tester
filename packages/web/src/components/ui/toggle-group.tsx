import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Toggle rows where more than one option can be on at once.
 *
 * Distinct from `Tabs`, and the distinction is the reason both exist. Tabs is
 * single-select: picking one surface unpicks the other. These are genuinely
 * multi-select - SDK Compare runs `raw` AND `openai-sdk` in the same request so
 * their behaviour can be diffed, and Tools & MCP offers several tool
 * definitions at once. Modelling those as Tabs would silently drop a selection.
 *
 * Radix supplies `aria-pressed` per item and arrow-key movement across the
 * group, neither of which the hand-rolled button rows had. The disabled case
 * matters here too: SDK Compare disables a client the current surface has no
 * method for, and a disabled `<button>` with a colour-only "off" look was
 * indistinguishable from an unselected one.
 */
const toggleItemVariants = cva(
  "mono inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-xs font-normal transition-colors outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: 'h-8 min-w-8 px-2.5 py-1',
        sm: 'h-7 min-w-7 px-2 text-[11px]',
      },
      tone: {
        // Selected reads as the action colour; unselected as a quiet outline.
        default:
          'border-input text-muted-foreground hover:border-ring/50 hover:text-foreground data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-primary',
        // Amber, for a toggle that turns on something deliberately wrong.
        warn: 'border-input text-muted-foreground hover:border-warn-foreground/50 data-[state=on]:border-warn-foreground/50 data-[state=on]:bg-warn data-[state=on]:text-warn-foreground',
      },
      // A disabled item must not merely look unselected.
      unavailable: {
        true: 'border-dashed border-border/60 text-muted-foreground/40 line-through decoration-1',
        false: '',
      },
    },
    defaultVariants: { size: 'default', tone: 'default', unavailable: false },
  },
);

function ToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    />
  );
}

function ToggleGroupItem({
  className,
  size,
  tone,
  unavailable,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleItemVariants>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleItemVariants({ size, tone, unavailable }), className)}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem, toggleItemVariants };
