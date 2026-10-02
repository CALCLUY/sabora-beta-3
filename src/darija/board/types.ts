export type BoardZone = "left" | "middle" | "right";

/** White body, yellow titles/terms, red accent, blue reserved for questions. */
export type ChalkColor = "white" | "yellow" | "red" | "blue";

export type BoardBlockType =
  | "heading"
  | "objective"
  | "definition"
  | "text"
  | "latex"
  | "formula"
  | "svg"
  | "list"
  | "example"
  | "takeaway"
  | "question";

export type AnnotationKind = "circle" | "arrow" | "underline";

export type BoardAnnotation = {
  id: string;
  kind: AnnotationKind;
  /** The exact visible characters being pointed at, e.g. "a" or "bi". */
  target: string;
  /** Which match to use when the target appears several times (1-based). */
  occurrence: number;
  /** Optional surrounding expression the target must sit inside ("z = a + ib"). */
  within?: string;
  /** Short simple-French note written at the arrow's tail ("partie réelle"). */
  label?: string;
  /** Which side of the target the arrow / label sits on. */
  side: "above" | "below";
  color: ChalkColor;
  createdAt: number;
};

export type BoardBlock = {
  id: string;
  zone: BoardZone;
  type: BoardBlockType;
  content: string;
  items?: string[];
  /** For type="example": the short French/topic title shown as "Exemple de … :" */
  title?: string;
  /** For type="definition": the highlighted French term before its white definition. */
  term?: string;
  /** Optional risky formula symbols; only these are colored red inside a formula. */
  accentSymbols?: string[];
  /** Hand-drawn circles / arrows / underlines pointing at parts of this block. */
  annotations?: BoardAnnotation[];
  color: ChalkColor;
  boxed: boolean;
  underline: boolean;
  large: boolean;
  createdAt: number;
};

/**
 * A hand-drawn arrow connecting a part of one block to a part of another —
 * for a flow/sequence ("step 1 → step 2") or a reference back to a rule already
 * on the board. Both blocks must be in the same zone. Omitting a target anchors
 * on that block's own edge instead of one specific character.
 */
export type BoardConnector = {
  id: string;
  zone: BoardZone;
  fromId: string;
  fromTarget?: string;
  fromOccurrence: number;
  toId: string;
  toTarget?: string;
  toOccurrence: number;
  label?: string;
  color: ChalkColor;
  createdAt: number;
};
