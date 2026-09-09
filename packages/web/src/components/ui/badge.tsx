import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one pill.
 *
 * Before this there were four: `StatusPill`, `VerdictPill`, the `! spends` /
 * `✓ free` chips inlined in ToolsMcp and Scenarios, and the `management` tag on
 * the credential rows. They shared a shape by coincidence, and the `free`/
 * `spends` pair had drifted to a different radius than the rest.
 *
 * The variant names are the app's verdict vocabulary rather than generic
 * severities, because that vocabulary is the product: a reader has to be able
 * to tell `budget` from `ratelimit`, and `pass`/`warn`/`fail`/`skip` is exactly
 * the `CheckStatus` union the engine already emits. `StatusPill` maps onto
 * these directly, so the domain layer keeps its API and loses its styling.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors [&>svg]:size-3',
  {
    variants: {
      variant: {
        pass: 'bg-ok text-ok-foreground ring-ok-foreground/25',
        warn: 'bg-warn text-warn-foreground ring-warn-foreground/25',
        fail: 'bg-fail text-fail-foreground ring-fail-foreground/25',
        info: 'bg-info text-info-foreground ring-info-foreground/25',
        skip: 'bg-muted text-muted-foreground ring-border',
        outline: 'bg-transparent text-muted-foreground ring-border',
      },
    },
    defaultVariants: { variant: 'skip' },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'span';
  return (
    <Component data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
