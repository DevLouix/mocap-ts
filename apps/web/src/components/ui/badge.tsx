import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge — a small status pill. Variant reflects mocap job stage semantics.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium transition-colors',
  {
    variants: {
      variant: {
        neutral: 'bg-surface-muted text-ink-muted',
        accent: 'bg-accent-subtle text-accent',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        danger: 'bg-danger/10 text-danger',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
