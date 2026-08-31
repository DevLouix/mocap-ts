import { Inngest } from 'inngest';

/**
 * The Inngest client for mocap-ts.
 *
 * Created lazily (so apps that don't use Inngest never load it). The
 * component functions live in `src/server/inngest/functions.ts`.
 */
export const inngest = new Inngest({
  id: 'mocap-ts',
  name: 'Mocap Studio',
});
