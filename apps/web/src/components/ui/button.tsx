import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button — Notion style: squared, low-shadow, quiet by default.
 * The `accent` variant is the one primary action per view.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        accent: 'bg-accent text-accent-foreground hover:bg-accent-hover shadow-card',
        outline: 'border border-border bg-surface hover:bg-surface-hover text-ink',
        ghost: 'hover:bg-surface-hover text-ink',
        subtle: 'bg-surface-muted hover:bg-surface-hover text-ink',
        danger: 'bg-danger text-white hover:opacity-90',
        link: 'text-accent hover:underline underline-offset-2 h-auto p-0',
      },
      size: {
        sm: 'h-8 px-3 text-2xs',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-4',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'accent', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
