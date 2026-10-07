/**
 * What a mod gets from `import { ... } from "mods"`: a small state library
 * on top of `$.state`.
 */

interface StateRef {
  readonly plugin: string;
  readonly key: string;
  readonly id?: string;
}

interface Atom<T> {
  readonly ref: StateRef;
  readonly initial: T;
}

interface Derived<T> {
  readonly sources: ReadonlyArray<Atom<unknown> | Derived<unknown>>;
  readonly compute: (...values: ReadonlyArray<unknown>) => T;
}

interface StateAccess {
  readonly state: {
    readonly get: (ref: StateRef) => Promise<{ readonly value: unknown; readonly version: number }>;
    readonly set: (
      ref: StateRef,
      value: unknown,
      options?: { readonly ifVersion?: number },
    ) => Promise<{ readonly isSet: boolean; readonly version: number }>;
  };
}

const isDerived = (source: unknown): source is Derived<unknown> =>
  typeof source === "object" && source !== null && "compute" in source;

/** A named value with its initial: read, it is never `undefined`. */
export const atom = <T>(ref: StateRef, initial: T): Atom<T> => Object.freeze({ ref, initial });

/** A value computed from atoms; reading it reads them. */
export const derive = <T>(
  sources: ReadonlyArray<Atom<unknown> | Derived<unknown>>,
  compute: (...values: ReadonlyArray<unknown>) => T,
): Derived<T> => Object.freeze({ sources, compute });

/** One member of a family of values, named by the instance being drawn. */
export const memberOf = <T>(family: Atom<T>, e: { readonly requestId?: string }): Atom<T> =>
  atom({ ...family.ref, id: e.requestId ?? "" }, family.initial);

export const read = async <T>($: StateAccess, source: Atom<T> | Derived<T>): Promise<T> => {
  if (isDerived(source)) {
    const values = await Promise.all(source.sources.map((inner) => read($, inner)));
    return source.compute(...values) as T;
  }
  const { value } = await $.state.get(source.ref);
  return value === undefined ? source.initial : (value as T);
};

/** Reads, applies `change` and writes; again on a miss, so two updates both land. */
export const update = async <T>($: StateAccess, target: Atom<T>, change: (value: T) => T) => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { value, version } = await $.state.get(target.ref);
    const next = change(value === undefined ? target.initial : (value as T));
    const written = await $.state.set(target.ref, next, { ifVersion: version });
    if (written.isSet) return next;
  }
  throw new Error(`update of ${target.ref.plugin}.${target.ref.key} kept missing`);
};

export const library = Object.freeze({ atom, derive, memberOf, read, update });
