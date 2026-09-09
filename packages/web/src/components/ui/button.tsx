import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * One button, five weights.
 *
 * Replaces 42 hand-rolled `<button>` elements that had drifted into three
 * different visual treatments with no shared source - "Run preflight" was a
 * solid blue, "List servers & tools" an outline, and the small copy/collapse
 * controls something else again. Nothing was wrong with any one of them; the
 * problem was that a fourth author would have invented a fifth.
 *
 * `spend` is not decoration. Several actions in this app cost real money
 * against a $2/month test key, and the ones that do were previously marked
 * only by a separate amber pill somewhere near them. Making it a button
 * variant puts the warning on the thing you click.
 */
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-transparent hover:bg-secondary/60 hover:text-foreground',
        ghost: 'hover:bg-secondary/60 hover:text-foreground',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        // Caution. Two things in this app warrant it and both are amber
        // already: an action that spends real money against the $2/month test
        // key, and a probe that deliberately exercises a known defect.
        warn: 'bg-warn text-warn-foreground ring-1 ring-inset ring-warn-foreground/30 hover:bg-warn/70',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        // For the in-corner controls on the JSON block, where a 32px button
        // would cover the payload it is meant to sit beside.
        xs: 'h-6 rounded px-1.5 text-[10px] has-[>svg]:px-1',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, keeping the styles. */
    asChild?: boolean;
  }) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
