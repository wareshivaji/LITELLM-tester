import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The surface switchers.
 *
 * These were hand-rolled button rows - `/v1/chat/completions` against
 * `/v1/responses` on four pages, and the tool-offer toggles on Tools & MCP.
 * Each was a `<button>` with a conditional class, which looked right and
 * behaved wrong: no arrow-key movement between options, no `role="tablist"`, and
 * the selected one distinguishable only by colour. Radix supplies the roving
 * tabindex and the ARIA wiring.
 *
 * Note the `segmented` variant. Several of these switchers pick a REQUEST
 * TARGET rather than reveal a panel - Playground sends to whichever surface is
 * lit - so there is no `TabsContent` beneath them. Radix Tabs is still the
 * right primitive for the keyboard behaviour, and the variant drops the
 * bottom-edge treatment that would imply a panel below.
 */
function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  variant = 'segmented',
  ...props
}: ComponentProps<typeof TabsPrimitive.List> & { variant?: 'segmented' | 'underline' }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        'inline-flex w-fit flex-wrap items-center',
        variant === 'segmented' && 'gap-1 rounded-md border border-border bg-muted/40 p-1',
        variant === 'underline' && 'gap-4 border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground',
        'data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/40',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
