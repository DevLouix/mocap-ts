import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Input — squared, subtle background, focused ring in accent.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-surface-subtle px-3 py-1 text-sm text-ink shadow-card transition-colors',
        'placeholder:text-ink-subtle',
        'focus-visible:border-accent focus-visible:bg-surface focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
