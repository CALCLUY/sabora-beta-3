export type LexEntry = {
  /** Latin (Arabizi) spelling as in DODa column n1 / darija */
  latin: string;
  /** Arabic-script spelling as in DODa column darija_ar */
  ar: string;
  /** English gloss as in DODa column eng */
  eng: string;
};

export type LexCategory = "utils" | "adverbs" | "prepositions" | "education" | "numbers" | "idioms";

export type DodaLexicon = Record<LexCategory, LexEntry[]>;

export type DodaSentence = {
  latin: string;
  eng: string;
  ar: string;
};
