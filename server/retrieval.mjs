const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "their", "this", "to", "use", "using", "was", "what", "when", "with",
]);

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique(values) {
  return [...new Set(values)];
}

export function buildSearchIndex(clusters) {
  const documents = clusters.map((cluster) => {
    const nameTokens = tokens(cluster.name);
    const descriptionTokens = tokens(cluster.description);
    return {
      cluster,
      nameTokens,
      descriptionTokens,
      allTokens: new Set([...nameTokens, ...descriptionTokens]),
    };
  });

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.allTokens) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  return { documents, documentFrequency, count: documents.length };
}

export function retrieveCandidates(index, query, limit = 14) {
  const queryTokens = unique(tokens(query));
  const lowerQuery = String(query || "").toLowerCase();
  const scored = index.documents.map((document) => {
    const nameCounts = new Map();
    const descriptionCounts = new Map();
    for (const token of document.nameTokens) nameCounts.set(token, (nameCounts.get(token) || 0) + 1);
    for (const token of document.descriptionTokens) descriptionCounts.set(token, (descriptionCounts.get(token) || 0) + 1);

    let score = 0;
    for (const token of queryTokens) {
      const frequency = index.documentFrequency.get(token) || 0;
      const idf = Math.log((index.count + 1) / (frequency + 1)) + 1;
      score += idf * ((nameCounts.get(token) || 0) * 3.2 + Math.min(descriptionCounts.get(token) || 0, 3));
    }

    const name = document.cluster.name.toLowerCase();
    if (lowerQuery.includes(name) || name.includes(lowerQuery)) score += 8;
    return { score, cluster: document.cluster };
  });

  return scored
    .sort((left, right) => right.score - left.score || right.cluster.ratio - left.cluster.ratio)
    .slice(0, limit)
    .map(({ score, cluster }) => ({
      id: cluster.id,
      name: cluster.name,
      description: cluster.description,
      referenceRatio: cluster.ratio,
      retrievalScore: Number(score.toFixed(3)),
    }));
}
