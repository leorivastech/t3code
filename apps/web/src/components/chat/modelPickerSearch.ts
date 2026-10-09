import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    buildModelPickerSearchText(model),
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores: Array<number> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const fieldScore = scoreModelPickerSearchToken(fields[index]!, token, index * 10);
      if (fieldScore !== null) {
        tokenScores.push(fieldScore);
      }
    }

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

const modelWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[\s\-_/()]+/u)
    .filter((word) => word.length > 0);

/**
 * The model a spoken name means. The picker's search decides what matches, but
 * not which match wins: its score favors the shortest name, so "opus" would
 * pick an old "Opus 5" over "Opus 5.5". When every word asked for is a word of
 * the model or its provider, the first one listed wins instead; favorites and
 * `preferFirst` matches (the instance already in use) go ahead of that order.
 */
export function pickModelByQuery<T extends ModelPickerSearchableModel>(
  models: ReadonlyArray<T>,
  query: string,
  preferFirst: (model: T) => boolean = () => false,
): T | null {
  const wanted = modelWords(query);
  if (wanted.length === 0) return null;
  let best: { model: T; score: number; rank: number; named: boolean } | null = null;
  for (const model of models) {
    const score = scoreModelPickerSearch(model, query);
    if (score === null) continue;
    const words = new Set(
      [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
        .filter((value): value is string => typeof value === "string")
        .flatMap(modelWords),
    );
    const named = wanted.every((word) => words.has(word));
    const rank = (named ? 0 : 4) + (model.isFavorite ? 0 : 2) + (preferFirst(model) ? 0 : 1);
    if (best === null || rank < best.rank || (rank === best.rank && !named && score < best.score)) {
      best = { model, score, rank, named };
    }
  }
  return best?.model ?? null;
}
