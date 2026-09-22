type ElementConstructor<T extends HTMLElement> = abstract new (...args: never[]) => T;
type ElementConstructors = Record<string, ElementConstructor<HTMLElement>>;

type SnakeCase<Value extends string> = Value extends `${infer Head}-${infer Tail}`
  ? `${Head}_${SnakeCase<Tail>}`
  : Value;

type Registry<Ids extends readonly string[], Specialized extends ElementConstructors> =
  Record<SnakeCase<Ids[number]>, HTMLElement>
  & { [Key in keyof Specialized]: InstanceType<Specialized[Key]> };

export function requiredElement<T extends HTMLElement>(id: string, constructor: ElementConstructor<T>): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id} to be a ${constructor.name}`);
  }
  return element;
}
export function optionalElement<T extends HTMLElement>(id: string, constructor: ElementConstructor<T>): T | null {
  const element = document.getElementById(id);
  if (element === null) return null;
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id} to be a ${constructor.name}`);
  }
  return element;
}

/**
 * Builds the static DOM registry and validates every required node at startup.
 * Elements needing subtype-only APIs must be listed in `specialized`; all
 * other entries deliberately expose only HTMLElement capabilities.
 */
export function createElementRegistry<
  const Ids extends readonly string[],
  const Specialized extends ElementConstructors,
>(ids: Ids, specialized: Specialized): Registry<Ids, Specialized> {
  const entries = ids.map(id => {
    const key = id.replaceAll("-", "_");
    const constructor = specialized[key] ?? HTMLElement;
    return [key, requiredElement(id, constructor)] as const;
  });
  return Object.fromEntries(entries) as Registry<Ids, Specialized>;
}
