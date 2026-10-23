const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const names = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((name) => typeof name === 'string' && name.trim().length > 0);
const date = (value: unknown) =>
  object(value) &&
  Object.keys(value).length === 2 &&
  integer(value.month, 1, 12) &&
  integer(value.day, 1, 30);

export function validLoreReadWhen(value: unknown): boolean {
  if (
    !object(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.any) ||
    !value.any.length
  )
    return false;
  return value.any.every((branch) => {
    if (!object(branch) || !Object.keys(branch).length) return false;
    return Object.entries(branch).every(([key, condition]) => {
      if (key === 'locations' || key === 'keywords') return names(condition);
      if (key !== 'annualWindow' || !object(condition)) return false;
      return (
        Object.keys(condition).length === 4 &&
        date(condition.start) &&
        date(condition.end) &&
        integer(condition.beforeDays, 0, 359) &&
        integer(condition.afterDays, 0, 359)
      );
    });
  });
}

export function validLoreDefinitions(value: unknown): boolean {
  return (
    object(value) &&
    Object.entries(value).every(
      ([key, text]) =>
        key.trim().length > 0 &&
        key === key.trim() &&
        typeof text === 'string' &&
        !/<%|\{\{(?:setvar|getvar|random)/.test(text),
    )
  );
}
