// Now let me test the actual RENDER in Board.tsx. The renderUnit adds {" "} after each unit.
// But the board uses renderChalkText which strips $ and wraps Arabic in spans.
// When rendered, it would be:
// "Soit " + [math:z=a+ib] + " " + "et " + "son " + "conjugué " + [math:\bar{z}=a-ib] + " "
// Each renderUnit ends with {" "} so there should be a space between units.
// That's fine.

// The "Soitz = a + ib" in the screenshot means the whitespace got lost between
// "Soit" and "z = a + ib". Since renderUnit adds {" "} after each unit, the space
// should be there UNLESS the content was NOT tokenized by tokenizeText but by a
// different path.

// Let me check: the definition block path in Board.tsx:
// <ChalkText text={`${term} :`} className="board-definition-term chalk-key-term" />
// <ChalkText text={block.content} className="board-text board-definition-copy" />
// So the term is "Soit" and content is "$z = a + ib$ et son conjugué $\bar{z} = a - ib$"

// In ChalkText: toFlatUnits(tokenizeText(text), inlineMath)
// For content "z = a + ib et $\bar{z} = a - ib$":
// This WOULD be split correctly with spaces.

// But wait - the screenshot says "Soitz = a + ibetz̄ = a − ib" which is all on ONE line.
// That means the ChalkText is rendering it as ONE line with the math NOT separated by spaces.
// This could happen when:
// 1. The model sends content = "Soit z = a + ib et $\bar{z} = a - ib$" WITHOUT the $
//    around z = a + ib, and WITHOUT proper spaces.
// 2. Or the model sends type='text' with content='Soit z = a + ib et z̄ = a - ib'
//    and the \bar{z} LaTeX command is not present.
// 3. Or the model strips whitespace inside math.

// The most likely cause: the model sent type='definition', term='Soit',
// content='z = a + ib et z̄ = a − ib'. And the term "Soit :" renders on the SAME line
// as the content because they are in the SAME flex container. Then the "z = a + ib et"
// is inline math with no leading space.

// Looking at renderChalkText: the `$` signs are stripped first:
// .replace(/\$/g, "") in renderLatexInlineSafe
// But in renderChalkText, the chunk "$z = a + ib$" is passed to MathInline which strips $.

// Let me check what happens when the board writes type='text' with content:
// "Soit $z = a + ib$ et son conjugué $\bar{z} = a - ib$"
// That goes through normalizeBoardWriteDefinition and normalizeBoardWriteMath.
// Since it contains "soit" (a NON_TERM_LABEL), normalizeBoardWriteDefinition rejects it.
// Since it has $ signs, normalizeBoardWriteMath might promote it to formula...
// If promoted to formula, the whole thing goes through renderLatexSafe which strips $.

// THAT'S the bug! normalizeBoardWriteMath sees $ in the text and converts the whole
// definition to type='formula'. Then renderLatexSafe renders the WHOLE sentence
// (including "Soit et son conjugué") as a single KaTeX display formula, which
// produces "Soitz = a + ibetz̄ = a − ib" without spaces because KaTeX treats
// letters as variables concatenated together!

// Fix: normalizeBoardWriteMath should NOT promote text with $ to formula if the
// text contains French prose. The $ delimiters should be KEPT for the prose path
// where inlineMath=true handles them correctly via ChalkText.

