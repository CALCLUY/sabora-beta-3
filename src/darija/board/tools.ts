/**
 * Gemini Live function declarations for the 2-zone classroom board:
 * middle = formal French exam content; right = examples in Darija, only after speech.
 */
import { Behavior, Type, type FunctionDeclaration } from "@google/genai";

export const BOARD_WRITE_TOOL: FunctionDeclaration = {
  name: "board_write",
  behavior: Behavior.BLOCKING,
  description:
    "Write on the blackboard while teaching. The two visible areas are: " +
    "- 'middle' (large formal French area): definitions, objectives, exam steps, formulas, diagrams and final answers. " +
    "- 'right' (examples in Moroccan Darija): EXAMPLES ONLY. It accepts nothing but type='example' with a title and a concrete worked Darija situation, written only after you say that example aloud. Never paste your spoken explanation, questions, greetings, comments or lesson steps here — those belong in zone='middle' or stay spoken. Invalid writes are rejected. " +
    "SEMANTIC TYPES + STRICT VISUAL POLICY: " +
    "heading = lesson title, YELLOW and underlined, never boxed. " +
    "objective = bullet/numbered lesson goals, WHITE and unboxed. " +
    "definition = French term plus formal French definition; supply 'term' and 'content'. Both are white except the term is yellow. Automatically boxed, no colored paragraph. " +
    "formula/latex = exact exam notation in raw LaTeX, WHITE and UNBOXED by default (worked steps, substitutions, example values). Set boxed=true ONLY for the single essential formula of the current point that students must memorize — at most one boxed formula per point. Optionally set accentSymbols to the single variable(s) students commonly confuse; ONLY those symbols are rendered red. Do not color the whole formula. " +
    "example = label 'Exemple de … :' in yellow, Darija example in white, never boxed. " +
    "question = a question you are asking the STUDENT right now: the whole question is written in BLUE chalk (its own reserved colour) with a 'Question :' label and a dashed rule, never boxed. ALWAYS write it here at the exact moment you ask it out loud, in zone='middle'. Write it ONLY in short, simple French (one short sentence, everyday words, no Arabic; math in $...$) even though you ask it aloud in Darija — e.g. 'Quelle est la partie réelle de $z = 3 + 2i$ ?'. It never erases anything on the board; it only replaces a previous pending question (one at a time). " +
    "takeaway = final answer/main takeaway, RED accent and automatically boxed. Red is reserved for final answers and specifically marked error-prone formula symbols only. If the takeaway IS an equation, write it as raw LaTeX exactly like a formula (e.g. (c)' = 0 as \\left(c\\right)' = 0) — never as plain characters; the board typesets it. " +
    "text and svg = white by default. Objectives use items as bullets. Leave color empty: the board enforces these semantic colors itself. " +
    "A question write NEVER erases anything: it only replaces a previous pending question. When a zone is full the board does NOT erase itself and nothing is written: the tool answers board_full and you must ASK the student for permission to erase. Only after they agree may you call board_clear (once), then continue the same point. Write in short, copyable chunks. " +
    "PACING: emit ONE board_write, then speak 2-3 sentences about exactly that line before the next write — never fire several writes back-to-back; the board reveals each line as you speak about it. Never send the same content twice: a 'duplicate' response means it is already there, so move on.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      zone: {
        type: Type.STRING,
        enum: ["middle", "right"],
        description: "'middle' = formal French content. 'right' = Darija example, only after spoken aloud.",
      },
      type: {
        type: Type.STRING,
        enum: ["heading", "objective", "definition", "text", "latex", "formula", "svg", "list", "example", "takeaway", "question"],
        description:
          "heading=yellow underlined title/no box; objective=white bullets/no box; definition=white formal wording with yellow 'term', auto-boxed; formula/latex=white exact math, unboxed unless boxed=true for the one key formula; example=yellow label + white Darija, no box; takeaway=red boxed/underlined final answer; question=a question you are asking the student now, in short simple French only (no Arabic), labelled 'Question :' in yellow, never boxed, never erases the board; text/svg=white.",
      },
      content: {
        type: Type.STRING,
        description:
          "Formal French text, raw LaTeX, SVG markup, or the exact Darija words already spoken for an example. Math is NEVER typed as plain characters: in type=formula/latex (and a takeaway that is only an equation) write raw LaTeX without $; inside prose (definition, text, question, objective items, example body) wrap EVERY math expression in $...$, e.g. 'un nombre de la forme $z = a + ib$ où $i^2 = -1$'.",
      },
      items: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Bullet items for objective or list blocks.",
      },
      title: {
        type: Type.STRING,
        description: "For type='example': the French concept ONLY (e.g. 'nombre complexe'), without the word 'Exemple' — the board already displays 'Exemple de <title> :'.",
      },
      term: {
        type: Type.STRING,
        description: "For type='definition': the key French term. It is yellow; the formal French definition remains white and is boxed.",
      },
      accentSymbols: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Optional for formula only: one to three single variables (e.g. ['m']) or approved Greek symbols that are common error traps. Only these characters are red; formula stays white. Leave empty unless there is a specific teaching reason.",
      },
      color: {
        type: Type.STRING,
        enum: ["white", "yellow", "red"],
        description: "Normally leave empty. The board chooses the semantic color by type and ignores conflicting choices.",
      },
      boxed: { type: Type.BOOLEAN, description: "Only for type=formula/latex: true ONLY for the one essential formula to memorize. Leave false for steps and examples. Definitions and takeaways are framed automatically; everything else is never framed." },
      underline: { type: Type.BOOLEAN, description: "Headings are automatically underlined; takeaways receive a bold underline." },
      large: { type: Type.BOOLEAN, description: "Headings are automatically large." },
    },
    required: ["zone", "type", "content"],
  },
};

export const BOARD_CLEAR_TOOL: FunctionDeclaration = {
  name: "board_clear",
  behavior: Behavior.BLOCKING,
  description:
    "Erase a zone or the whole board. The board automatically erases a zone when full; call this when changing topic or when examples are no longer relevant.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      zone: {
        type: Type.STRING,
        enum: ["middle", "right", "all"],
        description: "Zone to erase: 'middle' (formal area), 'right' (examples), or 'all'.",
      },
    },
  },
};

export const BOARD_REMOVE_TOOL: FunctionDeclaration = {
  name: "board_remove",
  behavior: Behavior.BLOCKING,
  description: "Erase a specific block from the blackboard using its id (returned by board_write).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "ID of the block to delete." },
    },
    required: ["id"],
  },
};

export const BOARD_ANNOTATE_TOOL: FunctionDeclaration = {
  name: "board_annotate",
  behavior: Behavior.BLOCKING,
  description:
    "PROACTIVE TEACHING TOOL — use it yourself, never wait for the student to ask, but use it ONLY where a mark changes what the student understands in the sentence you are saying right now. " +
    "TIMING: call it at the moment you speak about that exact symbol, so the mark appears as its meaning is heard. " +
    "SMART USE: arrow (kind='arrow') a symbol to its meaning when you NAME it (e.g. in z = a + bi: 'a' -> 'partie réelle', 'bi' -> 'partie imaginaire'; in E_c = 1/2 m v^2: 'm' -> 'masse', 'v' -> 'vitesse'); circle (kind='circle') ONE easy-to-miss detail as you say it (a minus sign, a small exponent, a subscript, a unit). Skip symbols you are not naming this turn — marks are teaching, not decoration. Max 2-3 marks per block; older marks expire when you move on. " +
    "WHEN TO CIRCLE (use freely and proactively): a single word/symbol/subscript students often misread (a minus sign, a small exponent, a silent letter) so it cannot be skipped; flagging 'pay attention here' in the middle of a line or equation without breaking flow the way a full box would; marking what the student just said (in the right zone) to show 'this is the point we build on', without rewriting it. Circle is for ONE small detail inside something bigger — it is NOT the same as boxed=true on board_write, which marks a whole formula/definition/answer as the final important unit (used once per concept). Clear a circle (kind='clear') once its point has been made if it is no longer needed. " +
    "WHEN TO ARROW: to show what a symbol or piece of a formula MEANS (target inside one block, e.g. the 'a' in z = a + bi is the 'partie réelle') — use this tool for that proactively! To show a SEQUENCE/FLOW between two different blocks (step 1 → step 2, cause → effect) or to point back to a rule/formula written earlier so the student sees why a step is valid, use board_connect instead (it links two blocks, not one). " +
    "AVOID ARROWS when two things are already next to each other on the board — proximity already shows the link. Keep at most 3 arrows on the whole board at once (board_annotate arrows + board_connect together). " +
    "Example, for the formula z = a + bi (write it first with board_write): call kind='arrow', target='a', label='partie réelle', side='below'; then kind='arrow', target='bi', label='partie imaginaire', side='above'. " +
    "Kinds: 'arrow' = arrow pointing at the target with the label written at its tail; 'circle' = confident double-loop drawn around the target (an optional label adds an arrow); 'underline' = underline with an optional label — good for 'pay attention' without a full circle; 'clear' = remove all annotations of that block. " +
    "TARGETS INSIDE A PROOF / MULTI-STEP DERIVATION: write each step as its OWN type='formula' block (raw LaTeX, e.g. content='a) \\; |z|^2 = z\\\\bar{z} = (a+ib)(a-ib)'), then annotate THAT block. Never put proof steps inside a type='text' block — the steps get split into fragments and the marks land in the wrong place. " +
    "target = the exact VISIBLE characters as displayed (for z = a + bi: 'a', 'bi', '=' or 'z'); no LaTeX commands, write Greek letters as α β θ…; use occurrence=2 for the second match. " +
    "TARGETING A SYMBOL SAFELY: a bare letter like 'a' also occurs inside French words, so before marking the parts of an equation, write that equation as its OWN block — board_write(zone='middle', type='formula', content='z = a + ib') — and mark that block. If the equation only exists inside a sentence, pass within='z = a + ib' together with target='a'. Ambiguous single letters are rejected. " +
    "label = 1-3 simple French words, NEVER Arabic. Use opposite sides (above/below) for neighbouring targets so labels do not collide (the board alternates them for you if you omit side). At most 4 annotations per block, and annotate only the part you are explaining now. " +
    "Call it right before you say the sentence about that part so the drawing appears in sync with your voice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: {
        type: Type.STRING,
        description: "Block id returned by board_write. Omit to annotate the most recently written block.",
      },
      kind: {
        type: Type.STRING,
        enum: ["arrow", "circle", "underline", "clear"],
        description: "arrow = labelled arrow; circle = loop around the target; underline = chalk underline; clear = remove this block's annotations.",
      },
      target: {
        type: Type.STRING,
        description: "Exact visible characters to point at, e.g. 'a', 'bi', '=', 'i^2' (no LaTeX commands; Greek as α β…). Required except for kind='clear'.",
      },
      occurrence: {
        type: Type.INTEGER,
        description: "Which match when the target appears several times (1 = first). Default 1.",
      },
      within: {
        type: Type.STRING,
        description:
          "The surrounding expression the target sits inside, e.g. within='z = a + ib', target='a'. Use it whenever the letter also appears in the sentence around the formula, so the mark cannot land on the wrong character.",
      },
      label: {
        type: Type.STRING,
        description: "Short note in simple French (max 3 words), e.g. 'partie réelle'. No Arabic.",
      },
      side: {
        type: Type.STRING,
        enum: ["above", "below"],
        description: "Side of the target the arrow and label use. Use opposite sides for neighbouring targets.",
      },
      color: {
        type: Type.STRING,
        enum: ["yellow", "white", "red"],
        description: "Default yellow. Use red ONLY to flag a common mistake or error-prone part.",
      },
    },
    required: ["kind"],
  },
};

export const BOARD_CONNECT_TOOL: FunctionDeclaration = {
  name: "board_connect",
  behavior: Behavior.BLOCKING,
  description:
    "PROACTIVE FLOW & REFERENCE ARROW TOOL: Do NOT wait for the student to ask! When you show a sequence or flow (step 1 → step 2, cause → effect, one idea building into the next: a process, a reaction, a cause/effect chain) or point back to a formula/rule written earlier so the student sees why the current step is valid, proactively call this tool to draw a connecting arrow between them. " +
    "Do not use this to point at a piece INSIDE one single block (use board_annotate for that) and do not connect two things that are already next to each other on the board — proximity already shows the link; an arrow there is redundant and just adds clutter. " +
    "HARD LIMIT: at most 3 arrows on the whole board at once, counting board_annotate arrows too — past that it stops reading as meaningful. Clear one (kind='clear') before adding a new one if you are at the limit. " +
    "fromId/toId are block ids returned by board_write, in the SAME zone. fromTarget/toTarget optionally point at the exact visible characters inside each block (omit to anchor on the block's own edge instead of one character). label is an optional 1-3 word simple French note at the arrow (no Arabic). " +
    "The board routes the arrow through the side margin by itself, so it never cuts across the text or other arrows — you never need to worry about crossings, just link the right two blocks. Arrows fade automatically once the lesson has moved a few blocks on, so use one per idea and never re-draw old ones. " +
    "Call it right before you say the sentence connecting the two ideas, so the arrow is drawn in sync with your voice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      kind: {
        type: Type.STRING,
        enum: ["flow", "clear"],
        description: "'flow' = draw the connecting arrow; 'clear' = remove connectors (optionally filtered by fromId/toId).",
      },
      fromId: { type: Type.STRING, description: "Block id the arrow starts at (the earlier step / the rule being referenced)." },
      fromTarget: { type: Type.STRING, description: "Optional exact visible characters inside the fromId block to start the arrow at." },
      fromOccurrence: { type: Type.INTEGER, description: "Which match of fromTarget when it appears more than once (default 1)." },
      toId: { type: Type.STRING, description: "Block id the arrow points at (the next step / the current line using the rule)." },
      toTarget: { type: Type.STRING, description: "Optional exact visible characters inside the toId block to point at." },
      toOccurrence: { type: Type.INTEGER, description: "Which match of toTarget when it appears more than once (default 1)." },
      label: { type: Type.STRING, description: "Optional short note in simple French (max 3 words), e.g. 'même règle'. No Arabic." },
      color: {
        type: Type.STRING,
        enum: ["yellow", "white", "red"],
        description: "Default yellow. Use red ONLY to flag a mistake or a risky step.",
      },
    },
    required: ["kind"],
  },
};

/**
 * Explicit PDF lesson progression. The app no longer guesses that a point is
 * complete just because Vox finished a voice turn: Vox calls this only after
 * hearing the learner's check answer and giving feedback.
 */
export const LESSON_POINT_COMPLETE_TOOL: FunctionDeclaration = {
  name: "lesson_point_complete",
  behavior: Behavior.BLOCKING,
  description:
    "Mark the current PDF teaching point complete AFTER the learner has answered its check question and you have responded to that exact answer with feedback. Call ONLY when the learner's answer is correct or they have completed one supported retry; never mark complete before asking the check, before the student's reply, or when they remain confused/unanswered. This is the ONLY way to advance PDF coverage; never advance/restart the PDF from your own guess. After calling, STOP this turn — teach the next point only after the next learner input.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pointId: { type: Type.STRING, description: "The exact current point id from [VOX-COVERAGE], e.g. P3." },
    },
    required: ["pointId"],
  },
};

export const BOARD_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  BOARD_WRITE_TOOL,
  BOARD_ANNOTATE_TOOL,
  BOARD_CONNECT_TOOL,
  BOARD_CLEAR_TOOL,
  BOARD_REMOVE_TOOL,
  LESSON_POINT_COMPLETE_TOOL,
];

export const BOARD_TOOL_NAMES = new Set(BOARD_FUNCTION_DECLARATIONS.map((tool) => tool.name));
