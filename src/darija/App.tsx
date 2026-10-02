"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type LiveServerToolCall,
  type Session,
} from "@google/genai";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronsRight,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  GraduationCap,
  Paperclip,
  KeyRound,
  LockKeyhole,
  Plus,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  buildTeacherSystemInstruction,
  DODA_REPO_URL,
  formatReferenceBlock,
  getDodaLexicon,
  getDodaSentenceIndex,
  sampleExampleSentences,
  SAMPLE_QUESTIONS,
  type DodaSentenceIndex,
  type LexiconLoadResult,
} from "./doda";
import { FALLBACK_LEXICON } from "./doda/fallback";
import {
  buildResumeHistory,
  buildTutorTurnContext,
  DEFAULT_TEACHING_PREFERENCES,
  isTutorAction,
  TEACHING_SOURCES,
  type LearnerLevel,
  type TeachingPreferences,
  type TutorAction,
} from "./teaching";
import { extractPdfText, PdfReadError, type ExtractedPdf } from "./pdf/extract";
import {
  analyzePdfWithGemini,
  buildDocumentContext,
  MAX_PDF_BYTES,
  type DocumentAnalysis,
  type LoadedDocument,
} from "./pdf/analyze";
import {
  buildCoverageAnswerContext,
  buildCoverageContext,
  getLessonPoints,
  nextUncoveredPoint,
  type LessonPoint,
} from "./pdf/coverage";
import {
  applyBoardAnnotate,
  applyBoardClear,
  applyBoardConnect,
  applyBoardRemove,
  applyBoardWrite,
  BOARD_FUNCTION_DECLARATIONS,
  Blackboard,
  buildFormalZoneFromAnalysis,
  buildPointHeading,
  countActiveArrows,
  exampleMentionedInSpeech,
  expireStaleConnectors,
  findDuplicateBlock,
  insertPreparedBlock,
  isDuplicateBody,
  isExampleWrite,
  isValidExampleArgs,
  hasArabicScript,
  MAX_QUESTION_CHARS,
  normalizeBoardWriteDefinition,
  normalizeBoardWriteMath,
  normalizeBoardWriteQuestion,
  prepareBoardWrite,
  pruneConnectors,
  replaceZone,
  type BoardBlock,
  type BoardConnector,
  type BoardZone,
} from "./board";

type DocPhase = "idle" | "reading" | "analyzing" | "error";

/** A board_write(type="example") call held back until the example is spoken. */
type PendingExample = { args: Record<string, unknown>; at: number };
/** How long a queued example may still be released after it was requested. */
const EXAMPLE_GRACE_MS = 45_000;

/** A board block created by a tool call, waiting for speech to catch up before it is revealed. */
type PendingReveal = { block: BoardBlock; queuedAt: number };
/**
 * Pacing for speech-synced reveals: minimum gap between reveals (lets the
 * handwriting animation finish and the student read), speech needed to unlock
 * the next reveal, and max wait while responding (covers audio outrunning text).
 */
const REVEAL_MIN_INTERVAL_MS = 1_100;
const REVEAL_MAX_WAIT_MS = 3_600;

const DOC_ACTIONS: { id: TutorAction; label: string; prompt: string }[] = [
  { id: "doc_lesson", label: "شرح ليا الدرس كامل", prompt: "شرح ليا الدرس ديال هاد الـ PDF كامل، نقطة بنقطة من اللول حتى نكملو كلشي." },
  {
    id: "doc_exercises",
    label: "نحلّو التمارين معا",
    prompt: "يالّاه نحلّو التمارين ديال هاد الـ PDF خطوة بخطوة، بلا ما تعطيني الحل ديريكت.",
  },
  { id: "doc_quiz", label: "اختبرني", prompt: "اختبرني على هاد الدرس، سؤال بسؤال." },
];

const MODEL = "gemini-3.8-live";
const OUTPUT_SAMPLE_RATE = 24_000;

type ConnectionStatus = "disconnected" | "connecting" | "connected";
type MessageStatus = "streaming" | "complete" | "interrupted";
type LoadStatus = "loading" | "ready" | "error";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  audioChunks?: string[];
  refCount?: number;
  document?: { name: string; pages: number; exercises: number; analyzed: boolean };
};

type DodaState = {
  lexicon: LoadStatus;
  sentences: LoadStatus;
  sentenceCount: number;
  entryCount: number;
  liveCategories: number;
};

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

function VoxLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dimensions = size === "lg" ? "h-16 w-16" : size === "sm" ? "h-8 w-8" : "h-10 w-10";
  return (
    <div className={`vox-logo ${dimensions}`} aria-hidden="true">
      <span className="h-2.5" />
      <span className="h-5" />
      <span className="h-3.5" />
    </div>
  );
}

function VoiceOrb({ active }: { active: boolean }) {
  return (
    <div className={`voice-orb ${active ? "is-active" : ""}`} aria-hidden="true">
      <div className="voice-orb-ring ring-one" />
      <div className="voice-orb-ring ring-two" />
      <div className="voice-orb-core">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function ThinkingBars() {
  return (
    <span className="thinking-bars" aria-label="الأستاذ كيجاوب">
      <span />
      <span />
      <span />
    </span>
  );
}

/** One-tap help: the fastest way for a student to say "I'm lost" without typing. */
const HELP_CHIPS: { id: TutorAction; label: string; prompt: string }[] = [
  { id: "simpler", label: "ما فهمتش", prompt: "ما فهمتش، عاود ليا بطريقة أسهل." },
  { id: "example", label: "مثال آخر", prompt: "عطيني مثال آخر على نفس الفكرة." },
  { id: "recap", label: "لخّص", prompt: "لخّص ليا اللي درنا حتى لهنا." },
];

const LEARNING_ACTIONS: { id: TutorAction; label: string; prompt: string }[] = [
  {
    id: "hint",
    label: "عطيني تلميح",
    prompt: "عطيني غير تلميح صغير فالخطوة اللي واقف فيها، بلا ما تعطيني الحل كامل.",
  },
  {
    id: "practice",
    label: "نجرب تمرين بوحدي",
    prompt: "عطيني تمرين جديد على هاد الفكرة نجربو بوحدي. تسنى جوابي قبل ما تورّيني الحل.",
  },
  {
    id: "review",
    label: "نراجع من الذاكرة",
    prompt: "سوّلني سؤال واحد على شي فكرة سبق قريناها، باش نجاوب من الذاكرة. ماتعطينيش الملخص ولا الجواب حتى نجرب.",
  },
  {
    id: "wrapup",
    label: "نختم الدرس ونخطّط للمراجعة",
    prompt: "نوقفو هنا. لخّص ليا شنو قدرت نطبّق وشنو باقي خاصني نراجع، وعطيني جوج أسئلة للمراجعة وخطة قصيرة نرجع بيها لهاد الدرس من بعد.",
  },
];

function TeachingSettings({
  preferences,
  onSave,
}: {
  preferences: TeachingPreferences;
  onSave: (preferences: TeachingPreferences) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(preferences);

  return (
    <>
      <button
        type="button"
        className="teaching-trigger"
        aria-haspopup="dialog"
        onClick={() => {
          setDraft({ ...preferences });
          dialogRef.current?.showModal();
        }}
      >
        <GraduationCap className="h-4 w-4" />
        <span>{preferences.mode === "guided" ? "تعلّم خطوة بخطوة" : "جواب مباشر"}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      <dialog
        ref={dialogRef}
        className="teaching-dialog"
        aria-labelledby="teaching-title"
        aria-describedby="teaching-description"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <form
          className="teaching-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({ ...draft });
            dialogRef.current?.close();
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-[#a3aeff]">الطريقة ديال الأستاذ Vox</p>
              <h2 id="teaching-title" className="mt-2 text-2xl font-medium text-zinc-100">نفهمو، نجرّبو، ونراجعو.</h2>
            </div>
            <button
              type="button"
              className="icon-button h-9 w-9"
              onClick={() => dialogRef.current?.close()}
              aria-label="سدّ إعدادات التعلّم"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p id="teaching-description" className="mt-3 text-sm leading-7 text-zinc-400">
            شرح واضح، تطبيق تدريجي، وretrieval practice. الطريقة كتبدّل حسب جوابك، ماشي درس طويل من جهة وحدة.
          </p>

          <fieldset className="mt-6">
            <legend className="text-sm font-medium text-zinc-200">كيفاش بغيتي نتعلّمو؟</legend>
            <label className="teaching-choice">
              <input
                type="radio"
                name="teaching-mode"
                value="guided"
                checked={draft.mode === "guided"}
                onChange={() => setDraft((current) => ({ ...current, mode: "guided" }))}
              />
              <span>
                <strong>خطوة بخطوة</strong>
                <small>فكرة وحدة، مثال، وسؤال واحد. الأستاذ كيتسنى جوابك.</small>
              </span>
            </label>
            <label className="teaching-choice">
              <input
                type="radio"
                name="teaching-mode"
                value="direct"
                checked={draft.mode === "direct"}
                onChange={() => setDraft((current) => ({ ...current, mode: "direct" }))}
              />
              <span>
                <strong>جواب مباشر</strong>
                <small>الجواب مع شرح مختصر، بلا اختبار إجباري.</small>
              </span>
            </label>
          </fieldset>

          <div className="mt-5">
            <label htmlFor="learner-level" className="mb-2 block text-sm font-medium text-zinc-200">المستوى ديالي فهاد الموضوع</label>
            <select
              id="learner-level"
              value={draft.level}
              className="teaching-select w-full"
              onChange={(event) => setDraft((current) => ({ ...current, level: event.target.value as LearnerLevel }))}
            >
              <option value="auto">حدّد المستوى حسب الأجوبة ديالي</option>
              <option value="beginner">مبتدئ، نبداو من الأساسيات</option>
              <option value="intermediate">عندي الأساسيات، بغيت نطبّق</option>
              <option value="advanced">متقدّم، بغيت نتعمّق</option>
            </select>
          </div>

          <ol className="teaching-cycle">
            <li><strong>نحدّدو الهدف.</strong> نشوفو شنو عارف من قبل وشنو باغي تتعلّم.</li>
            <li><strong>نورّيك الطريقة (I do).</strong> مثال مكملّ بالخطوات فالسبورة والشرح بالدارجة.</li>
            <li><strong>نكملّو بجوج (We do).</strong> خطة وحدة بقات ناقصة، كمّلها نتا.</li>
            <li><strong>تحل بوحدك (You do).</strong> تمرين مستقل متعمد بحال الامتحان.</li>
            <li><strong>نرجعو ليها من بعد.</strong> استرجاع من الذاكرة، تبدل بين الأنواع، وفترات متباعدة.</li>
          </ol>

          <details className="teaching-evidence">
            <summary>علاش اخترنا هاد الطريقة؟ شوف المصادر</summary>
            <p className="mt-3 text-xs leading-6 text-zinc-400">
              ماكايناش طريقة وحدة هي الأحسن للجميع. جمعنا مبادئ Rosenshine مع توصيات IES وEEF.
              الدليل على feedback وmetacognition واسع؛ الدليل على mastery learning محدود.
              هاد الأبحاث ماكتضمنش نفس النتيجة مع chatbot، والفعالية ديالو خاصها تقييم مع المتعلّمين.
            </p>
            <ul className="teaching-sources" dir="ltr">
              {TEACHING_SOURCES.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    <span>{source.title}<small>{source.publisher}</small></span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          </details>
          <p className="mt-5 text-[11px] leading-6 text-zinc-500">
            الإعدادات كتطبّق من الرسالة الجاية، وباقية غير فهاد الصفحة. المراجعات المقترحة ماشي تنبيهات مبرمجة.
          </p>
          <button type="submit" className="connect-button mt-4 w-full">حفظ الإعدادات</button>
        </form>
      </dialog>
    </>
  );
}

export default function App() {
  const [view, setView] = useState<"setup" | "chat">("setup");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [useDodaRefs, setUseDodaRefs] = useState(true);
  const [teachingPreferences, setTeachingPreferences] = useState<TeachingPreferences>({ ...DEFAULT_TEACHING_PREFERENCES });
  const [tutorAction, setTutorAction] = useState<TutorAction>("message");
  const [activeDocument, setActiveDocument] = useState<LoadedDocument | null>(null);
  const [docPhase, setDocPhase] = useState<DocPhase>("idle");
  const [docStatusText, setDocStatusText] = useState("");
  // Lesson coverage: the ordered checklist of every point in the PDF, what has
  // been taught, and which point the tutor must teach next. This is what stops
  // the tutor from explaining only some points and skipping the rest.
  const [coveredPointIds, setCoveredPointIds] = useState<string[]>([]);
  const [currentPointId, setCurrentPointId] = useState<string | null>(null);
  const [lessonPlanOpen, setLessonPlanOpen] = useState(false);
  const coveredPointIdsRef = useRef<string[]>([]);
  const currentPointIdRef = useRef<string | null>(null);
  const pendingLessonPointRef = useRef<string | null>(null);
  /** Current PDF point whose check question is awaiting the student's answer. */
  const awaitingCoverageAnswerRef = useRef<string | null>(null);
  /** Point whose answer-feedback turn is underway; cleared by lesson_point_complete. */
  const pendingCoverageFeedbackRef = useRef<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const documentRef = useRef<LoadedDocument | null>(null);
  const documentRemovedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const docAbortRef = useRef<AbortController | null>(null);
  const [doda, setDoda] = useState<DodaState>({
    lexicon: "loading",
    sentences: "loading",
    sentenceCount: 0,
    entryCount: 0,
    liveCategories: 0,
  });
  const [boardBlocks, setBoardBlocks] = useState<BoardBlock[]>([]);
  const [boardConnectors, setBoardConnectors] = useState<BoardConnector[]>([]);
  const [boardCollapsed, setBoardCollapsed] = useState(false);
  const [boardFocus, setBoardFocus] = useState(false);
  const boardBlocksRef = useRef<BoardBlock[]>([]);
  const boardConnectorsRef = useRef<BoardConnector[]>([]);
  const pendingExamplesRef = useRef<PendingExample[]>([]);
  const pendingRevealsRef = useRef<PendingReveal[]>([]);
  const lastRevealRef = useRef<{ at: number; transcriptLen: number }>({ at: 0, transcriptLen: 0 });
  const lastTranscriptRef = useRef("");

  /**
   * Replaces the board's blocks and drops any connector arrow whose block was
   * removed in the process (erased / cleared), so a dangling arrow never points
   * at something that no longer exists.
   */
  const commitBoardBlocks = useCallback((next: BoardBlock[]) => {
    boardBlocksRef.current = next;
    setBoardBlocks(next);
    // Drop arrows whose block is gone, and arrows whose ends are several blocks in
    // the past — so the 3-arrow budget is never used up by old material.
    const prunedConnectors = expireStaleConnectors(pruneConnectors(boardConnectorsRef.current, next), next);
    if (prunedConnectors !== boardConnectorsRef.current) {
      boardConnectorsRef.current = prunedConnectors;
      setBoardConnectors(prunedConnectors);
    }
  }, []);

  /* --------------------- Lesson coverage (whole PDF) ---------------------- */
  const lessonPoints: LessonPoint[] = useMemo(
    () => getLessonPoints(activeDocument),
    [activeDocument],
  );

  const setCoverage = useCallback((covered: string[], current: string | null) => {
    coveredPointIdsRef.current = covered;
    currentPointIdRef.current = current;
    setCoveredPointIds(covered);
    setCurrentPointId(current);
  }, []);

  const resetCoverage = useCallback(() => {
    pendingLessonPointRef.current = null;
    awaitingCoverageAnswerRef.current = null;
    pendingCoverageFeedbackRef.current = null;
    coveredPointIdsRef.current = [];
    currentPointIdRef.current = null;
    setCoveredPointIds([]);
    setCurrentPointId(null);
    setLessonPlanOpen(false);
  }, []);

  const markPointCovered = useCallback((pointId: string, covered: boolean) => {
    const current = new Set(coveredPointIdsRef.current);
    if (covered) current.add(pointId);
    else current.delete(pointId);
    const next = lessonPointsRefSafe();
    function lessonPointsRefSafe() {
      return getLessonPoints(documentRef.current);
    }
    const nextCurrent = currentPointIdRef.current && !current.has(currentPointIdRef.current)
      ? currentPointIdRef.current
      : (nextUncoveredPoint(next, [...current])?.id ?? null);
    setCoverage([...current], nextCurrent);
  }, [setCoverage]);

  const sessionRef = useRef<Session | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const connectionIdRef = useRef(0);
  const pendingAssistantIdRef = useRef<string | null>(null);
  const pendingAssistantTextRef = useRef("");
  const pendingAudioChunksRef = useRef<string[]>([]);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lexiconRef = useRef<LexiconLoadResult | null>(null);
  const sentenceIndexRef = useRef<DodaSentenceIndex | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextAudioTimeRef = useRef(0);
  const activeSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  /** Total scheduled audio duration so we can gauge speech progress for reveal pacing. */
  const scheduledDurationRef = useRef(0);
  /** Timestamp of when the first audio chunk of the current turn started playing. */
  const speechStartRef = useRef(0);

  /* ---------------------------- DODa loading ---------------------------- */
  useEffect(() => {
    let cancelled = false;

    getDodaLexicon()
      .then((result) => {
        if (cancelled) return;
        lexiconRef.current = result;
        setDoda((current) => ({
          ...current,
          lexicon: result.liveCategories.length ? "ready" : "error",
          entryCount: result.entryCount,
          liveCategories: result.liveCategories.length,
        }));
      })
      .catch(() => {
        if (!cancelled) setDoda((current) => ({ ...current, lexicon: "error" }));
      });

    getDodaSentenceIndex()
      .then((index) => {
        if (cancelled) return;
        sentenceIndexRef.current = index;
        setDoda((current) => ({ ...current, sentences: "ready", sentenceCount: index.size }));
      })
      .catch(() => {
        if (!cancelled) setDoda((current) => ({ ...current, sentences: "error" }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------- Audio -------------------------------- */
  const ensureAudio = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      const context = new AudioContext();
      const gain = context.createGain();
      gain.connect(context.destination);
      audioContextRef.current = context;
      gainNodeRef.current = gain;
      nextAudioTimeRef.current = context.currentTime;
    }
    const context = audioContextRef.current;
    if (context.state === "suspended") void context.resume();
    return context;
  }, []);

  const stopAudio = useCallback(() => {
    activeSourcesRef.current.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    });
    activeSourcesRef.current.clear();
    setIsSpeaking(false);
    if (audioContextRef.current) nextAudioTimeRef.current = audioContextRef.current.currentTime;
  }, []);

  const playPcmChunk = useCallback(
    (base64Audio: string) => {
      try {
        const context = ensureAudio();
        const binary = atob(base64Audio);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

        const sampleCount = Math.floor(bytes.byteLength / 2);
        if (!sampleCount) return;

        const audioBuffer = context.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
        const channel = audioBuffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < sampleCount; index += 1) {
          channel[index] = view.getInt16(index * 2, true) / 32768;
        }

        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNodeRef.current!);
        const startAt = Math.max(context.currentTime + 0.025, nextAudioTimeRef.current);
        nextAudioTimeRef.current = startAt + audioBuffer.duration;
        activeSourcesRef.current.add(source);
        setIsSpeaking(true);
        if (speechStartRef.current === 0) speechStartRef.current = Date.now();
        scheduledDurationRef.current += audioBuffer.duration;
        source.onended = () => {
          activeSourcesRef.current.delete(source);
          if (activeSourcesRef.current.size === 0) setIsSpeaking(false);
        };
        source.start(startAt);
      } catch {
        setError("ما قدرناش نشغّلو الصوت فهاد المتصفح.");
      }
    },
    [ensureAudio],
  );

  /* --------------------------- Live messages ---------------------------- */
  const ensurePendingAssistant = useCallback(() => {
    if (pendingAssistantIdRef.current) return pendingAssistantIdRef.current;
    const id = createId();
    pendingAssistantIdRef.current = id;
    pendingAssistantTextRef.current = "";
    pendingAudioChunksRef.current = [];
    setIsResponding(true);
    setMessages((current) => [...current, { id, role: "assistant", content: "", status: "streaming" }]);
    return id;
  }, []);

  /** The transcript currently being spoken, or the last one if the turn already finished. */
  const recentTranscript = useCallback(() => {
    const pending = pendingAssistantTextRef.current.trim();
    return pending || lastTranscriptRef.current;
  }, []);

  /**
   * Releases queued examples once they are actually spoken.
   * Entries survive across turns for a grace window because the tool call can
   * arrive after turnComplete, when the pending transcript is already cleared.
   */
  const flushSpokenExamples = useCallback(() => {
    const pending = pendingExamplesRef.current;
    if (!pending.length) return;
    const transcript = recentTranscript();
    if (!transcript) return;
    const now = Date.now();
    const keep: PendingExample[] = [];
    let queued = [...pendingRevealsRef.current];
    for (const entry of pending) {
      if (exampleMentionedInSpeech(entry.args, transcript)) {
        // Speech has reached the example: prepare/deduplicate it, but let the
        // transcript-paced reveal queue put it on the board at the right moment.
        const prepared = prepareBoardWrite(
          boardBlocksRef.current,
          queued.map((item) => item.block),
          entry.args,
        );
        // There is no "full" state: a full zone auto-erases its oldest content
        // on insert, so a speech-confirmed example is simply queued for reveal.
        if (prepared.status === "ok") queued.push({ block: prepared.block, queuedAt: now });
      } else if (now - entry.at < EXAMPLE_GRACE_MS) {
        keep.push(entry);
      }
    }
    pendingExamplesRef.current = keep;
    pendingRevealsRef.current = queued;
  }, [recentTranscript]);

  /**
   * Speech-synced reveal pacing: tool calls arrive in a burst at the start of a
   * turn, but the board must not show everything before speech finishes. Blocks
   * are revealed progressively as the teacher speaks about them, so writing and
   * voice stay on the same idea and the student keeps focus.
   */
  const revealNextBlock = useCallback(() => {
    const next = pendingRevealsRef.current[0];
    if (!next) return false;
    pendingRevealsRef.current = pendingRevealsRef.current.slice(1);
    // insertPreparedBlock auto-erases the zone's oldest content when it is full,
    // so revealing never blocks the lesson on a full board.
    commitBoardBlocks(insertPreparedBlock(boardBlocksRef.current, next.block));
    lastRevealRef.current = { at: Date.now(), transcriptLen: pendingAssistantTextRef.current.length };
    return true;
  }, [commitBoardBlocks]);

  const maybeRevealQueuedBlocks = useCallback(() => {
    if (!pendingRevealsRef.current.length) return;
    if (!pendingAssistantIdRef.current) return;
    // Minimum gap between reveals lets the handwriting animation play.
    if (Date.now() - lastRevealRef.current.at < REVEAL_MIN_INTERVAL_MS) return;
    // Voice-synced pacing: release blocks based on how far the spoken audio has
    // progressed since the last reveal. The total scheduled audio duration tells
    // us how long the turn will be; activeSources tells us how much has played.
    const speechMs = Date.now() - speechStartRef.current;
    const audioProgress = speechStartRef.current > 0 ? Math.min(1, speechMs / Math.max(2000, scheduledDurationRef.current * 1000)) : 0;
    const revealFloor = Math.floor(audioProgress * (pendingRevealsRef.current.length + 1));
    const alreadyRevealed = pendingRevealsRef.current.length;
    const shouldReveal = alreadyRevealed > revealFloor || Date.now() - lastRevealRef.current.at >= REVEAL_MAX_WAIT_MS;
    if (shouldReveal) revealNextBlock();
  }, [revealNextBlock]);

  const flushRevealQueue = useCallback(() => {
    // Turn is over and the audio has finished. Reveal anything remaining so the
    // student still sees the reference content — this is not "unsaid" content,
    // the tutor said it but the reveal timer did not catch up fast enough.
    // insertPreparedBlock auto-erases a full zone, so nothing blocks here.
    while (pendingRevealsRef.current.length) {
      const next = pendingRevealsRef.current.shift();
      if (!next) break;
      commitBoardBlocks(insertPreparedBlock(boardBlocksRef.current, next.block));
    }
    lastRevealRef.current = { at: Date.now(), transcriptLen: pendingAssistantTextRef.current.length };
  }, [commitBoardBlocks]);

  const enqueueReveal = useCallback((block: BoardBlock) => {
    // Only one pending question matters: a newer question replaces an older queued one.
    const queue =
      block.type === "question"
        ? pendingRevealsRef.current.filter((entry) => entry.block.type !== "question")
        : pendingRevealsRef.current;
    // Idempotent even when the model repeats a function call after a pause/retry.
    if (findDuplicateBlock([...boardBlocksRef.current, ...queue.map((entry) => entry.block)], block)) return;
    pendingRevealsRef.current = [...queue, { block, queuedAt: Date.now() }];
  }, []);

  // Fallback pacing: if speech continues without transcript growth (audio
  // outrunning transcription), still release queued blocks every few seconds.
  useEffect(() => {
    if (!isResponding) return;
    const timer = window.setInterval(() => {
      maybeRevealQueuedBlocks();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isResponding, maybeRevealQueuedBlocks]);

  const finishPendingAssistant = useCallback((interrupted = false) => {
    const id = pendingAssistantIdRef.current;
    const text = pendingAssistantTextRef.current.trim();
    const audioChunks = [...pendingAudioChunksRef.current];
    if (id) {
      const status: MessageStatus = interrupted || (!text && !audioChunks.length) ? "interrupted" : "complete";
      setMessages((current) => current.map((message) => message.id === id
        ? { ...message, content: text, audioChunks, status }
        : message));

      if (!interrupted && text) {
        // Remember the spoken text so a board_write that arrives after turnComplete
        // can still be matched against what was actually said.
        lastTranscriptRef.current = text;
        flushSpokenExamples();
        // Turn over: reveal anything still waiting so no content is lost.
        flushRevealQueue();
        // Do NOT auto-advance PDF coverage when Vox finishes speaking: the student
        // has not answered the check question yet. Keep this exact point current
        // until the learner answers and Vox gives feedback + lesson_point_complete.
        const pendingPoint = pendingLessonPointRef.current;
        if (pendingPoint && documentRef.current) {
          awaitingCoverageAnswerRef.current = pendingPoint;
          pendingLessonPointRef.current = null;
        }
      }
    }
    pendingAssistantIdRef.current = null;
    pendingAssistantTextRef.current = "";
    pendingAudioChunksRef.current = [];
    setIsResponding(false);
  }, [flushSpokenExamples, flushRevealQueue, setCoverage]);

  const processLiveMessage = useCallback(
    (message: LiveServerMessage) => {
      const content = message.serverContent;
      if (!content) return;

      if (content.interrupted) {
        stopAudio();
        finishPendingAssistant(true);
        return;
      }

      for (const part of content.modelTurn?.parts ?? []) {
        const audioData = part.inlineData?.data;
        if (typeof audioData === "string" && part.inlineData?.mimeType?.startsWith("audio/")) {
          ensurePendingAssistant();
          pendingAudioChunksRef.current.push(audioData);
          playPcmChunk(audioData);
        }
      }

      const transcript = content.outputTranscription?.text;
      if (transcript) {
        const assistantId = ensurePendingAssistant();
        pendingAssistantTextRef.current += transcript;
        const transcriptSoFar = pendingAssistantTextRef.current;
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId ? { ...item, content: transcriptSoFar } : item,
          ),
        );
        flushSpokenExamples();
        maybeRevealQueuedBlocks();
      }

      if (content.turnComplete) {
        finishPendingAssistant();
      }
    },
    [ensurePendingAssistant, finishPendingAssistant, flushSpokenExamples, maybeRevealQueuedBlocks, playPcmChunk, stopAudio],
  );

  /* -------------------------- Blackboard tool calls ---------------------- */
  const [boardErasing, setBoardErasing] = useState(false);
  const boardErasingRef = useRef(false);

  /** Erases a zone (or the whole board) with a wipe animation. Queued-but-unrevealed
   *  blocks in the erased zone are dropped at once. This just erases — it never
   *  asks the student for permission, so the lesson is never blocked on a prompt. */
  const eraseBoard = useCallback((zone?: BoardZone) => {
    if (boardErasingRef.current) return;
    pendingRevealsRef.current = zone
      ? pendingRevealsRef.current.filter((entry) => entry.block.zone !== zone)
      : [];
    boardErasingRef.current = true;
    setBoardErasing(true);
    window.setTimeout(() => {
      const next = applyBoardClear(boardBlocksRef.current, zone);
      commitBoardBlocks(next);
      setBoardErasing(false);
      boardErasingRef.current = false;
    }, 780);
  }, [commitBoardBlocks]);

  /** Auto-erase the oldest (least important) blocks when a zone overflows, so the
   *  board recycles itself and the lesson keeps flowing without blocking. */
  const onEraseBlocks = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const next = boardBlocksRef.current.filter((b) => !idSet.has(b.id));
    if (next.length !== boardBlocksRef.current.length) {
      boardBlocksRef.current = next;
      setBoardBlocks(next);
    }
  }, []);

  /** DOM-overflow safety net: drop the oldest erasable block in the overflowed zone. */
  const onZoneOverflow = useCallback(
    (zone: BoardZone) => {
      const zoneBlocks = boardBlocksRef.current.filter((b) => b.zone === zone);
      const victim = zoneBlocks
        .filter((b) => !b.boxed && b.type !== "heading" && b.type !== "question")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (victim) onEraseBlocks([victim.id]);
    },
    [onEraseBlocks],
  );

  const processToolCall = useCallback((toolCall: LiveServerToolCall) => {
    const calls = toolCall.functionCalls ?? [];
    if (!calls.length) return;

    const responses = calls.map((call) => {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;

      if (name === "board_write") {
        // Zone rules: 'middle' is French/math only; 'right' and type='example'
        // are the Darija example zone. An example asked for the middle zone is
        // forced to the right one, but Arabic in any formal type is rejected.
        const isFormalZone = args.zone !== "right" && args.type !== "example";
        const rightZone = isExampleWrite(args) && !isFormalZone;
        const formalArgs = isFormalZone ? { ...args, zone: "middle" } : args;
        if (rightZone) {
          const writeArgs = normalizeBoardWriteMath({ ...args, zone: "right" });
          // The right zone is examples only — never a dumping ground for speech.
          const valid = isValidExampleArgs(args);
          if (!valid.ok) {
            return {
              id: call.id,
              name,
              response: { status: "rejected", retryable: false, message: valid.reason },
            };
          }
          // No double examples: the same example already visible, already waiting
          // for reveal, or already waiting for its speech cue is never added twice.
          const exampleCandidate = {
            zone: "right" as const,
            type: "example",
            content: writeArgs.content,
            items: writeArgs.items,
            title: writeArgs.title,
          };
          const revealBlocks = pendingRevealsRef.current.map((entry) => entry.block);
          const alreadyShown =
            findDuplicateBlock([...boardBlocksRef.current, ...revealBlocks], exampleCandidate) != null;
          const alreadyPending = pendingExamplesRef.current.some((entry) =>
            isDuplicateBody(
              {
                zone: "right",
                type: "example",
                content: entry.args.content,
                items: entry.args.items,
                title: entry.args.title,
              },
              exampleCandidate,
            ),
          );
          if (alreadyShown || alreadyPending) {
            return {
              id: call.id,
              name,
              response: {
                status: "duplicate",
                retryable: false,
                message: "This exact example is already on the board or queued. Do not send it again; move on to teaching it.",
              },
            };
          }
          const spoken = recentTranscript();
          if (!exampleMentionedInSpeech(args, spoken)) {
            pendingExamplesRef.current = [...pendingExamplesRef.current, { args: writeArgs, at: Date.now() }];
            return {
              id: call.id,
              name,
              response: {
                status: "queued",
                retryable: false,
                message: "Example held until its Darija body is heard in speech. Do not retry it or put other speech in the right zone.",
              },
            };
          }
          // The Darija body has been spoken: queue the example now and reveal it
          // during that same utterance, never before the voice reaches it.
          const exampleQueued = pendingRevealsRef.current.map((entry) => entry.block);
          const preparedExample = prepareBoardWrite(boardBlocksRef.current, exampleQueued, writeArgs);
          if (preparedExample.status === "duplicate") {
            return {
              id: call.id,
              name,
              response: { status: "duplicate", retryable: false, message: "This exact example is already on the board or queued. Do not send it again." },
            };
          }
          // No "full" state: a full zone auto-erases its oldest content on insert.
          enqueueReveal(preparedExample.block);
          return {
            id: call.id,
            name,
            response: {
              status: "ok",
              retryable: false,
              id: preparedExample.block.id,
              type: preparedExample.block.type,
              color: preparedExample.block.color,
              message: "The example is queued to appear in sync with its spoken Darija lines; do not repeat it or write it a second time.",
            },
          };
        }
        // Formal zone: normalize, then validate against visible + queued blocks,
        // then reveal now if nothing is waiting or enqueue for speech-paced reveal.
        // A question posed to the learner is detected before any other
        // normalization so it is never mistaken for a definition or a formula.
        const questionArgs = normalizeBoardWriteQuestion(formalArgs);
        const isQuestionWrite = questionArgs.type === "question";

        if (isQuestionWrite) {
          // Board questions are ALWAYS short, simple French — never Arabic. The
          // tutor asks aloud in Darija; the board shows the simple French version.
          const questionText = typeof questionArgs.content === "string" ? questionArgs.content : "";
          if (hasArabicScript([questionArgs.content, questionArgs.items, questionArgs.term, questionArgs.title])) {
            return {
              id: call.id,
              name,
              response: {
                status: "rejected",
                retryable: true,
                message:
                  "Board questions must be written in SIMPLE FRENCH only (one short sentence, everyday words, no Arabic; math in $...$). Keep asking it aloud in Darija, and resend ONCE: board_write(zone='middle', type='question', content='<the same question in simple French>').",
              },
            };
          }
          if (questionText.length > MAX_QUESTION_CHARS) {
            return {
              id: call.id,
              name,
              response: {
                status: "rejected",
                retryable: true,
                message:
                  "Board question too long. Resend ONCE as one short, simple French sentence (about 15 words max, math in $...$).",
              },
            };
          }
        } else if (hasArabicScript([formalArgs.content, formalArgs.items, formalArgs.term, formalArgs.title])) {
          // Large formal zone is an exam-style French/math surface, never Arabic prose.
          return {
            id: call.id,
            name,
            response: {
              status: "rejected",
              retryable: false,
              message: "The middle board zone accepts formal French and LaTeX only. Keep Darija in your voice; only a genuine spoken Darija example belongs in the right zone (zone='right').",
            },
          };
        }

        // "Term : definition" plain text becomes a framed definition block
        // automatically (prose tail); otherwise formula-looking plain text becomes
        // a real formula block ("Label : equation" stays text for the split renderer).
        const normalizedFormal = isQuestionWrite
          ? questionArgs
          : normalizeBoardWriteMath(normalizeBoardWriteDefinition(formalArgs));
        const queuedBlocks = pendingRevealsRef.current.map((entry) => entry.block);
        const prepared = prepareBoardWrite(boardBlocksRef.current, queuedBlocks, normalizedFormal);
        if (prepared.status === "duplicate") {
          return {
            id: call.id,
            name,
            response: { status: "duplicate", retryable: false, message: "This exact content is already on the board. Do not send it again; move on." },
          };
        }
        // Every block waits for speech progression — including the first. This
        // prevents a whole block/definition from appearing while Vox is still silent.
        // A full zone auto-erases its oldest content on reveal; nothing is blocked.
        enqueueReveal(prepared.block);
        return {
          id: call.id,
          name,
          response: {
            status: "ok",
            retryable: false,
            id: prepared.block.id,
            type: prepared.block.type,
            color: prepared.block.color,
            message:
              "On the board (revealing in sync with your speech). Now speak the WHY in darija referencing this exact line — do not read the board aloud or restate it word for word.",
          },
        };
      }
      if (name === "board_clear") {
        // The board never asks permission — the tutor erases directly so the
        // lesson is never blocked on a student prompt.
        eraseBoard(args.zone === "right" ? "right" : undefined);
        return {
          id: call.id,
          name,
          response: {
            status: "ok",
            retryable: false,
            message: "The board is being erased. Continue teaching this same point on the fresh board.",
          },
        };
      }
      if (name === "board_annotate") {
        // Search visible + not-yet-revealed blocks: the target may still be queued.
        const annoQueued = pendingRevealsRef.current.map((entry) => entry.block);
        const annoCombined = [...boardBlocksRef.current, ...annoQueued];
        const activeArrows = countActiveArrows(annoCombined, boardConnectorsRef.current);
        const result = applyBoardAnnotate(annoCombined, args, activeArrows);
        if (!result.ok) {
          return {
            id: call.id,
            name,
            response: { status: "rejected", retryable: true, message: result.message },
          };
        }
        // Route the annotated block back to whichever list holds it.
        const updatedAnno = result.blocks.find((b) => b.id === result.blockId);
        const visibleIdx = boardBlocksRef.current.findIndex((b) => b.id === result.blockId);
        if (visibleIdx >= 0 && updatedAnno) {
          const nextVisible = [...boardBlocksRef.current];
          nextVisible[visibleIdx] = updatedAnno;
          boardBlocksRef.current = nextVisible;
          setBoardBlocks(nextVisible);
        } else if (updatedAnno) {
          pendingRevealsRef.current = pendingRevealsRef.current.map((entry) =>
            entry.block.id === result.blockId ? { ...entry, block: updatedAnno } : entry,
          );
        }
        return {
          id: call.id,
          name,
          response: {
            status: "ok",
            retryable: false,
            id: result.blockId,
            message: "Mark drawn. Now name this symbol and say what it means in darija, exactly as the mark appears — do not describe the mark itself or read the board.",
          },
        };
      }
      if (name === "board_connect") {
        // Ends may still be queued for reveal; the arrow only renders once both ends exist.
        const connectBlocks = [...boardBlocksRef.current, ...pendingRevealsRef.current.map((entry) => entry.block)];
        const result = applyBoardConnect(connectBlocks, boardConnectorsRef.current, args);
        if (!result.ok) {
          return {
            id: call.id,
            name,
            response: { status: "rejected", retryable: true, message: result.message },
          };
        }
        boardConnectorsRef.current = result.connectors;
        setBoardConnectors(result.connectors);
        return {
          id: call.id,
          name,
          response: {
            status: "ok",
            retryable: false,
            id: result.connector?.id,
            message: "Arrow drawn between the two blocks. Now say in darija WHY they are linked (this step uses that rule / this leads to that) — do not describe the arrow itself.",
          },
        };
      }
      if (name === "lesson_point_complete") {
        const pointId = typeof args.pointId === "string" ? args.pointId.trim() : "";
        const awaiting = awaitingCoverageAnswerRef.current;
        if (!pointId || !awaiting || pointId !== awaiting || pendingCoverageFeedbackRef.current !== pointId) {
          return {
            id: call.id,
            name,
            response: {
              status: "rejected",
              retryable: false,
              message:
                "Coverage was NOT advanced. Only mark the current PDF point after the student answered its check question and you gave feedback. Keep the same point current; never restart the document.",
            },
          };
        }
        const points = getLessonPoints(documentRef.current);
        const point = points.find((item) => item.id === pointId);
        if (!point) {
          return { id: call.id, name, response: { status: "rejected", retryable: false, message: "PDF point id not found; do not advance coverage." } };
        }
        const covered = new Set(coveredPointIdsRef.current);
        covered.add(pointId);
        const next = nextUncoveredPoint(points, [...covered]);
        setCoverage([...covered], next ? next.id : null);
        awaitingCoverageAnswerRef.current = null;
        pendingCoverageFeedbackRef.current = null;
        return {
          id: call.id,
          name,
          response: {
            status: "ok",
            retryable: false,
            covered: pointId,
            nextPoint: next ? { id: next.id, title: next.title, pages: next.pages } : null,
            message: next
              ? `Point covered. The next point is '${next.title}'${next.pages ? ` (p.${next.pages})` : ""}. Stop this turn now; do NOT start it until the learner's next input.`
              : "All PDF points are now covered. Stop this turn; the final recap comes on the next learner input.",
          },
        };
      }
      if (name === "board_remove") {
        const blocks = applyBoardRemove(boardBlocksRef.current, args.id);
        commitBoardBlocks(blocks);
        return { id: call.id, name, response: { status: "ok" } };
      }
      return { id: call.id, name, response: { status: "error", error: "unknown tool" } };
    });

    // Board tools are declared BLOCKING (auto-canceling in 3.8 Live): the model
    // pauses for this instant local acknowledgement and then continues the SAME
    // generation, so speech always follows a board write in one continuous turn.
    // (Non-blocking + SILENT could leave the turn silent; WHEN_IDLE could add a
    // second burst after a pause — blocking avoids both.)
    sessionRef.current?.sendToolResponse({ functionResponses: responses });
  }, [recentTranscript, commitBoardBlocks, eraseBoard, enqueueReveal]);

  const buildSystemInstruction = useCallback(() => {
    const lexicon = lexiconRef.current;
    const index = sentenceIndexRef.current;
    return buildTeacherSystemInstruction({
      lexicon: lexicon ? lexicon.lexicon : FALLBACK_LEXICON,
      examples: sampleExampleSentences(index, 36),
      sentenceCount: index?.size ?? 0,
      liveCategories: lexicon?.liveCategories.length ?? 0,
      teaching: teachingPreferences,
    });
  }, [teachingPreferences]);

  const connect = useCallback(
    async (key: string) => {
      const cleanKey = key.trim();
      if (!cleanKey) {
        setError("دخّل Gemini API key باش تكمّل.");
        return;
      }

      ensureAudio();
      stopAudio();
      finishPendingAssistant(true);
      setError("");
      setConnectionStatus("connecting");

      const connectionId = connectionIdRef.current + 1;
      connectionIdRef.current = connectionId;
      const oldSession = sessionRef.current;
      sessionRef.current = null;
      oldSession?.close();
      const history = buildResumeHistory(messagesRef.current);
      let connectionClosed = false;

      try {
        const ai = new GoogleGenAI({ apiKey: cleanKey });
        const session = await ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            temperature: 0.7,
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
            },
            systemInstruction: buildSystemInstruction(),
            tools: [{ functionDeclarations: BOARD_FUNCTION_DECLARATIONS }],
          },
          callbacks: {
            onmessage: (message) => {
              if (connectionId !== connectionIdRef.current) return;
              if (message.toolCall) {
                processToolCall(message.toolCall);
                return;
              }
              processLiveMessage(message);
            },
            onerror: (event) => {
              if (connectionId !== connectionIdRef.current) return;
              connectionClosed = true;
              setError(event.message || "وقع مشكل فالاتصال بـ Gemini Live.");
              setConnectionStatus("disconnected");
              stopAudio();
              finishPendingAssistant(true);
            },
            onclose: (event) => {
              if (connectionId !== connectionIdRef.current) return;
              connectionClosed = true;
              sessionRef.current = null;
              setConnectionStatus("disconnected");
              finishPendingAssistant(true);
              if (event.code !== 1000) {
                setError(event.reason || "الجلسة تقطعات. عاود الاتصال باش تكمّل.");
              }
            },
          },
        });

        if (connectionId !== connectionIdRef.current || connectionClosed) {
          session.close();
          return;
        }

        sessionRef.current = session;
        // Re-attach the uploaded PDF so the tutor keeps teaching the same document,
        // including the coverage checklist so it resumes where it stopped.
        if (documentRef.current) {
          const reattachPoints = getLessonPoints(documentRef.current);
          const reattachCoverage = reattachPoints.length
            ? buildCoverageContext(reattachPoints, coveredPointIdsRef.current, currentPointIdRef.current)
            : "";
          session.sendClientContent({
            turns: [{
              role: "user",
              parts: [
                { text: buildDocumentContext(documentRef.current) },
                ...(reattachCoverage ? [{ text: reattachCoverage }] : []),
              ],
            }],
            turnComplete: false,
          });
        }
        // Restore the lesson without asking Gemini to generate a new answer.
        if (history.turns.length) {
          session.sendClientContent({ turns: history.turns, turnComplete: false });
        }
        if (history.truncated) {
          setError("رجّعنا آخر جزء من المحادثة. إلا كان الهدف ولا شي تفصيل قديم ناقص، ذكّر الأستاذ بيه.");
        }
        setApiKey(cleanKey);
        setConnectionStatus("connected");
        setView("chat");
      } catch (caughtError) {
        if (connectionId !== connectionIdRef.current) return;
        sessionRef.current?.close();
        sessionRef.current = null;
        const message = caughtError instanceof Error ? caughtError.message : "";
        setError(message || "ما قدرناش نتّاصلو بـ Gemini Live. تأكّد من المفتاح ديالك.");
        setConnectionStatus("disconnected");
      }
    },
    [buildSystemInstruction, ensureAudio, finishPendingAssistant, processLiveMessage, processToolCall, stopAudio],
  );

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = isMuted ? 0 : 1;
  }, [isMuted]);

  useEffect(() => {
    messagesRef.current = messages;
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [input, view]);

  useEffect(() => {
    return () => {
      connectionIdRef.current += 1;
      sessionRef.current?.close();
      activeSourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch {
          // Ignore during teardown.
        }
      });
      void audioContextRef.current?.close();
    };
  }, []);

  /* ------------------------------ Actions ------------------------------- */
  const handleSetupSubmit = (event: FormEvent) => {
    event.preventDefault();
    void connect(apiKey);
  };

  const canSubmitTurn = () =>
    connectionStatus === "connected" && !isResponding && !pendingAssistantIdRef.current && Boolean(sessionRef.current);

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    if (submitTurn(text, tutorAction)) {
      setInput("");
      setTutorAction("message");
    }
  };

  /**
   * "Continue" control: asks the tutor to carry on explaining from where it stopped.
   * It is NOT an answer to any pending question (see ACTION_INSTRUCTIONS.continue),
   * and it leaves any typed draft untouched so the learner can still send it later.
   */
  const continueTurn = () => {
    // "Continue" just asks the tutor to keep going from where it stopped. The board
    // auto-erases a full zone by itself, so there is no erase-permission step here.
    submitTurn("كمّل", "continue");
  };

  /** Sends one learner turn (with DODa refs, tutor context and optional document block). */
  const submitTurn = (
    text: string,
    action: TutorAction,
    options: { documentContext?: string; document?: ChatMessage["document"] } = {},
  ): boolean => {
    if (!text || !canSubmitTurn() || !sessionRef.current) return false;

    ensureAudio();
    stopAudio();
    setError("");

    let referenceBlock = "";
    let refCount = 0;
    if (useDodaRefs && sentenceIndexRef.current) {
      const hits = sentenceIndexRef.current.search(text, 5);
      if (hits.length) {
        referenceBlock = formatReferenceBlock(hits);
        refCount = hits.length;
      }
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: text,
      status: "complete",
      document: options.document,
    };
    const assistantId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
      refCount,
    };

    pendingAssistantIdRef.current = assistantId;
    pendingAssistantTextRef.current = "";
    pendingAudioChunksRef.current = [];
    speechStartRef.current = 0;
    scheduledDurationRef.current = 0;
    speechStartRef.current = 0;
    scheduledDurationRef.current = 0;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsResponding(true);

    // PDF coverage is answer-gated: finishing the tutor's explanation does NOT
    // advance the checklist. After the learner replies to the point's check
    // question, the tutor gives feedback and explicitly calls lesson_point_complete.
    let coverageBlock = "";
    if (documentRef.current && !documentRemovedRef.current) {
      const points = getLessonPoints(documentRef.current);
      if (points.length) {
        const covered = new Set(coveredPointIdsRef.current);
        let current = currentPointIdRef.current;
        if (!current || covered.has(current)) {
          current = nextUncoveredPoint(points, [...covered])?.id ?? null;
          setCoverage([...covered], current);
        }

        const awaitingId = awaitingCoverageAnswerRef.current;
        const awaitingPoint = points.find((point) => point.id === awaitingId);
        // Only an ordinary learner message is an answer. "Continue", hint, retry,
        // and PDF-action buttons must never count as the student's answer.
        const learnerAnswerTurn = awaitingPoint && action === "message" && text.trim() !== "كمّل";

        if (learnerAnswerTurn && awaitingPoint) {
          coverageBlock = buildCoverageAnswerContext(awaitingPoint);
          pendingCoverageFeedbackRef.current = awaitingPoint.id;
        } else {
          coverageBlock = buildCoverageContext(points, [...covered], current);
        }

        if (action === "doc_start" || action === "doc_lesson" || action === "doc_exercises") {
          pendingLessonPointRef.current = current;
          // Starting/re-entering the lesson explicitly means teach the current
          // uncovered point; this is not itself evidence that a point is covered.
          if (action !== "doc_exercises") pendingCoverageFeedbackRef.current = null;

          // Seed the current PDF point's yellow heading before any model-written
          // content. This anchors the definition/steps/formula so the board is
          // organized around exactly what the tutor is teaching now.
          const point = points.find((item) => item.id === current);
          if (point) {
            const headingCandidate = { zone: "middle" as const, type: "heading", content: point.title };
            const alreadyVisible = findDuplicateBlock(boardBlocksRef.current, headingCandidate);
            const alreadyQueued = findDuplicateBlock(
              pendingRevealsRef.current.map((entry) => entry.block),
              headingCandidate,
            );
            if (!alreadyVisible && !alreadyQueued) enqueueReveal(buildPointHeading(point));
          }
        }
      }
    }

    try {
      const parts = [
        ...(options.documentContext ? [{ text: options.documentContext }] : []),
        ...(documentRemovedRef.current && !options.documentContext
          ? [{ text: "[VOX-TUTOR] The learner removed the previously uploaded PDF. Stop teaching from it unless they mention it again. [/VOX-TUTOR]" }]
          : []),
        ...(referenceBlock ? [{ text: referenceBlock }] : []),
        { text: buildTutorTurnContext(teachingPreferences, action) },
        ...(coverageBlock ? [{ text: coverageBlock }] : []),
        { text },
      ];
      sessionRef.current.sendClientContent({ turns: [{ role: "user", parts }], turnComplete: true });
      documentRemovedRef.current = false;
      return true;
    } catch {
      finishPendingAssistant(true);
      setError("ما قدرناش نصيفطو الرسالة. عاود الاتصال و جرّب مرّة خرا.");
      setConnectionStatus("disconnected");
      return false;
    }
  };

  /* ------------------------------ PDF upload ----------------------------- */
  const handlePdfFile = async (file: File) => {
    if (docPhase === "reading" || docPhase === "analyzing") return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      setDocPhase("error");
      setDocStatusText("غير ملفات PDF اللي مقبولة.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setDocPhase("error");
      setDocStatusText("الملف كبير بزّاف (الحد 15 MB). قسّمو ولا صيفط غير الصفحات اللي محتاج.");
      return;
    }
    if (connectionStatus !== "connected") {
      setDocPhase("error");
      setDocStatusText("عاود الاتصال بـ Gemini قبل ما ترفع الملف.");
      return;
    }

    docAbortRef.current?.abort();
    const controller = new AbortController();
    docAbortRef.current = controller;
    const warnings: string[] = [];

    // 1) Local text layer (fast, private, works offline).
    setDocPhase("reading");
    setDocStatusText(`كنقراو «${file.name}»…`);
    let extracted: ExtractedPdf | null = null;
    try {
      extracted = await extractPdfText(await file.arrayBuffer());
      if (extracted.pageCount > extracted.pages.length) {
        warnings.push(`Only the first ${extracted.pages.length} of ${extracted.pageCount} pages have a local text layer.`);
      }
      if (extracted.looksScanned) warnings.push("The PDF looks scanned: the local text layer is mostly empty.");
    } catch (readError) {
      if (readError instanceof PdfReadError && readError.code !== "unknown") {
        setDocPhase("error");
        setDocStatusText(readError.message);
        return;
      }
      warnings.push("Local text extraction failed.");
    }
    if (controller.signal.aborted) return;

    // 2) Gemini reads the whole PDF (equations, figures, scans) and builds a teaching map.
    setDocPhase("analyzing");
    setDocStatusText("الأستاذ كيقرا الدرس و التمارين و كيوجّد الشرح…");
    let analysis: DocumentAnalysis | null = null;
    let analysisModel: string | null = null;
    try {
      const result = await analyzePdfWithGemini(apiKey, file, controller.signal);
      analysis = result.analysis;
      analysisModel = result.model;
    } catch (analysisError) {
      if (controller.signal.aborted) return;
      warnings.push(
        `Gemini document analysis failed (${analysisError instanceof Error ? analysisError.message.slice(0, 160) : "unknown"}); teaching from the text layer only.`,
      );
    }
    if (controller.signal.aborted) return;

    const hasText = Boolean(extracted && extracted.totalChars > 80);
    if (!analysis && !hasText) {
      setDocPhase("error");
      setDocStatusText("ما قدرناش نقراو المحتوى ديال هاد الـ PDF (ممكن يكون صورة بلا نص). جرّب ملف آخر ولا عاود من بعد.");
      return;
    }

    const loaded: LoadedDocument = {
      id: createId(),
      fileName: file.name,
      sizeBytes: file.size,
      pageCount: extracted?.pageCount ?? 0,
      analysis,
      extracted,
      analysisModel,
      warnings,
    };

    documentRef.current = loaded;
    documentRemovedRef.current = false;
    setActiveDocument(loaded);
    // Fresh coverage checklist for the new document.
    resetCoverage();
    setDocPhase("idle");
    setDocStatusText(analysis ? "" : "تحلّل غير النص ديال الملف؛ الرسومات و المعادلات ممكن ما يكونوش واضحين.");

    if (analysis) {
      // Large merged area: formal French/exam content. Right zone starts completely empty until an example is spoken!
      const formalBlocks = buildFormalZoneFromAnalysis(analysis);
      let nextBoard = replaceZone(boardBlocksRef.current, "left", []);
      nextBoard = replaceZone(nextBoard, "middle", formalBlocks);
      nextBoard = replaceZone(nextBoard, "right", []);
      // Fresh lesson context: drop anything still waiting for reveal.
      pendingRevealsRef.current = [];
      commitBoardBlocks(nextBoard);
    }

    const pagesLabel = loaded.pageCount ? ` (${loaded.pageCount} صفحات)` : "";
    const sent = submitTurn(`رفعت الملف «${file.name}»${pagesLabel}. يلا نبداو نشرحو أول فكرة مباشرة.`, "doc_start", {
      documentContext: buildDocumentContext(loaded),
      document: {
        name: file.name,
        pages: loaded.pageCount,
        exercises: analysis?.exercises.length ?? 0,
        analyzed: Boolean(analysis),
      },
    });
    if (!sent) {
      setDocStatusText("الملف واجد. صيفط رسالة ولا اختار «شرح ليا الدرس» باش نبداو.");
    }
  };

  const removeDocument = () => {
    docAbortRef.current?.abort();
    if (documentRef.current) documentRemovedRef.current = true;
    documentRef.current = null;
    setActiveDocument(null);
    resetCoverage();
    setDocPhase("idle");
    setDocStatusText("");
  };

  /** Jump to a specific lesson point (from the plan list) and teach exactly it. */
  const jumpToLessonPoint = (point: LessonPoint) => {
    setCoverage(coveredPointIdsRef.current.filter((id) => id !== point.id), point.id);
    pendingLessonPointRef.current = point.id;
    submitTurn(`شرح ليا هاد النقطة من الدرس: «${point.title}»${point.pages ? ` (الصفحة ${point.pages})` : ""}.`, "doc_lesson");
  };

  /** Advance to the next uncovered point and teach it. */
  const teachNextPoint = () => {
    const points = getLessonPoints(documentRef.current);
    const next = nextUncoveredPoint(points, coveredPointIdsRef.current);
    if (!next) return;
    setCoverage(coveredPointIdsRef.current, next.id);
    pendingLessonPointRef.current = next.id;
    submitTurn(`كمّل للنقطة الجاية فالدرس: «${next.title}».`, "doc_lesson");
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  };

  const startNewChat = () => {
    docAbortRef.current?.abort();
    documentRef.current = null;
    documentRemovedRef.current = false;
    setActiveDocument(null);
    setDocPhase("idle");
    setDocStatusText("");
    messagesRef.current = [];
    setMessages([]);
    setInput("");
    setTutorAction("message");
    setIsResponding(false);
    pendingAssistantIdRef.current = null;
    pendingAssistantTextRef.current = "";
    pendingAudioChunksRef.current = [];
    boardBlocksRef.current = [];
    boardConnectorsRef.current = [];
    pendingExamplesRef.current = [];
    lastTranscriptRef.current = "";
    resetCoverage();
    setBoardBlocks([]);
    setBoardConnectors([]);
    void connect(apiKey);
  };

  const changeApiKey = () => {
    connectionIdRef.current += 1;
    finishPendingAssistant(true);
    sessionRef.current?.close();
    sessionRef.current = null;
    stopAudio();
    setConnectionStatus("disconnected");
    setError("");
    setView("setup");
  };

  const replayAudio = (chunks: string[]) => {
    stopAudio();
    chunks.forEach(playPcmChunk);
  };

  const dodaSummary =
    doda.sentences === "ready"
      ? `${formatNumber(doda.sentenceCount)} جملة`
      : doda.sentences === "loading"
        ? "كيتحمّل…"
        : doda.lexicon === "ready"
          ? "المعجم فقط"
          : "نسخة مدمجة";

  /* ---------------------------- Setup screen ---------------------------- */
  if (view === "setup") {
    return (
      <main className="setup-screen min-h-dvh overflow-hidden bg-[#090a0c] text-white">
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />

        <header className="relative z-10 flex h-20 items-center justify-between px-6 sm:px-10">
          <div className="flex items-center gap-3">
            <VoxLogo size="sm" />
            <span className="text-sm font-semibold tracking-[0.22em]">VOX</span>
          </div>
          <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#6d7cff]" />
            Gemini Live · Darija Open Dataset
          </div>
        </header>

        <section className="relative z-10 mx-auto flex min-h-[calc(100dvh-5rem)] max-w-xl flex-col justify-center px-6 pb-20 pt-8">
          <div className="setup-enter">
            <VoxLogo size="lg" />
            <p className="mt-10 text-xs font-medium uppercase tracking-[0.28em] text-[#8b96ff]">
              Gemini 3.8 Live · DODa
            </p>
            <h1 className="mt-4 text-5xl font-medium tracking-[-0.02em] text-white sm:text-6xl">
              الأستاذ Vox
            </h1>
            <p className="mt-5 max-w-md text-base leading-8 text-zinc-400 sm:text-lg">
              نفهمو الفكرة، نطبّقوها، ونرجعو ليها باش تبقى فالذاكرة. بالدارجة بالحروف العربية،
              المصطلحات العلمية بالفرنسية، والشرح بالنص وبالصوت.
            </p>
            <div className="mt-5">
              <TeachingSettings preferences={teachingPreferences} onSave={setTeachingPreferences} />
            </div>

            <form onSubmit={handleSetupSubmit} className="mt-10">
              <label htmlFor="api-key" className="mb-3 block text-sm font-medium text-zinc-300">
                Google AI API key
              </label>
              <div className={`key-field ${error ? "has-error" : ""}`} dir="ltr">
                <KeyRound className="h-4 w-4 shrink-0 text-zinc-500" />
                <input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    if (error) setError("");
                  }}
                  placeholder="AIza..."
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-left text-sm text-white outline-none placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((current) => !current)}
                  className="icon-button h-8 w-8"
                  aria-label={showKey ? "خبّي المفتاح" : "ورّي المفتاح"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {error && <p role="alert" className="mt-3 text-sm leading-6 text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={connectionStatus === "connecting" || !apiKey.trim()}
                className="connect-button mt-5 w-full"
              >
                {connectionStatus === "connecting" ? (
                  <>
                    <span className="button-spinner" />
                    كنتّاصلو بـ Gemini…
                  </>
                ) : (
                  <>
                    بدا التعلّم
                    <ArrowLeft className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 flex flex-col gap-3 text-xs leading-6 text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-2">
                <LockKeyhole className="h-3.5 w-3.5" />
                المفتاح ديالك كيبقا فهاد الصفحة و ما كيتسجّل حتى بلاصة.
              </span>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-zinc-400 transition-colors hover:text-white"
              >
                جيب API key
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div className="doda-card mt-8">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#a3aeff]">
                <BookOpen className="h-3.5 w-3.5" />
                Darija Open Dataset
                <span className={`status-dot ${doda.sentences === "ready" ? "is-ready" : doda.sentences === "loading" ? "is-loading" : "is-error"}`} />
              </div>
              <p className="mt-2 text-xs leading-6 text-zinc-400">
                {doda.lexicon === "ready"
                  ? `المعجم: ${formatNumber(doda.entryCount)} مدخل بالحروف العربية (${doda.liveCategories} ملفات).`
                  : doda.lexicon === "loading"
                    ? "المعجم كيتحمّل من GitHub…"
                    : "المعجم: النسخة المدمجة."}{" "}
                {doda.sentences === "ready"
                  ? `الجمل: ${formatNumber(doda.sentenceCount)} جملة مراجَعة جاهزة للـ retrieval.`
                  : doda.sentences === "loading"
                    ? "الجمل (≈49k) كيتحمّلو فالخلفية…"
                    : "الجمل: ما تحمّلوش، غانخدمو بالنسخة المدمجة."}
              </p>
              <a
                href={DODA_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-white"
                dir="ltr"
              >
                github.com/darija-open-dataset/dataset
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </section>
      </main>
    );
  }

  /* ----------------------------- Chat screen ---------------------------- */
  const canSend = Boolean(input.trim()) && connectionStatus === "connected" && !isResponding;
  // "Continue" needs a live session and something to continue, but no typed text.
  const canContinue = connectionStatus === "connected" && !isResponding && messages.length > 0;

  return (
    <main
      className={`chat-shell relative flex h-dvh flex-col overflow-hidden bg-[#090a0c] text-white${boardFocus ? " board-focus" : ""}`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void handlePdfFile(file);
      }}
    >
      {isDragging && (
        <div className="drop-overlay" aria-hidden="true">
          <FileUp className="h-8 w-8" />
          <p>حطّ الـ PDF هنا باش الأستاذ يشرحو ليك</p>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handlePdfFile(file);
        }}
      />
      <header className="chat-header relative z-20 flex h-16 shrink-0 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <VoxLogo size="sm" />
          <div>
            <div className="text-sm font-semibold">الأستاذ Vox</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500" dir="ltr">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connectionStatus === "connected" ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
              {connectionStatus === "connected" ? MODEL : connectionStatus === "connecting" ? "connecting…" : "offline"}
            </div>
          </div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            onClick={() => setIsMuted((current) => !current)}
            className="header-icon-button"
            aria-label={isMuted ? "شغّل الصوت" : "سكّت الصوت"}
            title={isMuted ? "شغّل الصوت" : "سكّت الصوت"}
          >
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={startNewChat}
            disabled={connectionStatus === "connecting"}
            className="header-icon-button"
            title="محادثة جديدة"
            aria-label="محادثة جديدة"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={changeApiKey}
            className="header-icon-button"
            aria-label="بدّل المفتاح"
            title="بدّل المفتاح"
          >
            <KeyRound className="h-4 w-4" />
          </button>
          <div className="header-sep" aria-hidden="true" />
          <button
            type="button"
            onClick={() => setUseDodaRefs((current) => !current)}
            className={`header-pill ${useDodaRefs ? "is-on" : ""}`}
            title={
              useDodaRefs
                ? `DODa retrieval خدّام (${dodaSummary}). كليكي باش تحبسو.`
                : "DODa retrieval محبوس. كليكي باش تشغّلو."
            }
            aria-pressed={useDodaRefs}
            aria-label={useDodaRefs ? "حبس المراجع اللغوية ديال DODa" : "شغّل المراجع اللغوية ديال DODa"}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">DODa</span>
            <span
              className={`status-dot ${doda.sentences === "ready" ? "is-ready" : doda.sentences === "loading" ? "is-loading" : "is-error"}`}
            />
          </button>
        </div>
      </header>

      <Blackboard
        blocks={boardBlocks}
        connectors={boardConnectors}
        collapsed={boardCollapsed}
        onToggleCollapsed={() => setBoardCollapsed((current) => !current)}
        onClear={(zone) => {
          eraseBoard(zone);
        }}
        onZoneOverflow={onZoneOverflow}
        focus={boardFocus}
        onToggleFocus={() => setBoardFocus((current) => !current)}
      />

      <section className="relative min-h-0 flex-1 overflow-y-auto" aria-label="المحادثة">
        <div className="chat-glow" />
        {messages.length === 0 ? (
          <div className="empty-enter relative z-10 mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 pb-20 text-center">
            <VoiceOrb active={isSpeaking} />
            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-xs text-[#a3aeff]">
              <GraduationCap className="h-3.5 w-3.5 text-[#8b96ff]" />
              <span>أستاذ بالدارجة + français scientifique · DODa</span>
            </div>
            <h1 className="mt-4 text-3xl font-medium text-zinc-100 sm:text-4xl">شنو بغيتي نشرح ليك اليوم؟</h1>
            <p className="mt-3 max-w-md text-sm leading-7 text-zinc-400">
              اختار موضوع ولا كتب الهدف ديالك. نشرحو بشوية، تجرّب نتا، ونصحّحو بجوج.
              بالدارجة المغربية والمصطلحات العلمية بالفرنسية.
            </p>

            <button
              type="button"
              onClick={openFilePicker}
              disabled={connectionStatus !== "connected" || docPhase === "reading" || docPhase === "analyzing"}
              className="upload-card mt-8 w-full max-w-xl"
            >
              <span className="upload-card-icon">
                <FileUp className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-start">
                <strong>رفع PDF ديال درس ولا تمارين</strong>
                <small>الأستاذ كيقرا الملف كامل، كيشرح الدرس، و كيحل معاك التمارين خطوة بخطوة. ولا جرّو و حطّو هنا.</small>
              </span>
            </button>

            <div className="mt-3 grid w-full max-w-xl grid-cols-1 gap-2.5 text-start sm:grid-cols-2">
              {SAMPLE_QUESTIONS.map((question) => (
                <button
                  key={question.badge}
                  type="button"
                  onClick={() => {
                    setInput(question.prompt);
                    setTutorAction("message");
                    // Pre-seed the large merged formal zone with an exam-style French heading.
                    const topicBlocks = [
                      {
                        id: `blk-${Date.now()}-topic`,
                        zone: "middle" as const,
                        type: "heading" as const,
                        content: question.badge,
                        color: "yellow" as const,
                        boxed: false,
                        underline: true,
                        large: true,
                        createdAt: Date.now(),
                      },
                      {
                        id: `blk-${Date.now()}-obj`,
                        zone: "middle" as const,
                        type: "objective" as const,
                        content: "Sujet sélectionné — préparation du cours formel",
                        color: "white" as const,
                        boxed: false,
                        underline: false,
                        large: false,
                        createdAt: Date.now(),
                      },
                    ];
                    const next = replaceZone(boardBlocksRef.current, "middle", topicBlocks);
                    pendingRevealsRef.current = pendingRevealsRef.current.filter(
                      (entry) => entry.block.zone !== "middle",
                    );
                    commitBoardBlocks(next);
                    textareaRef.current?.focus();
                  }}
                  className="group relative rounded-xl border border-white/8 bg-white/[0.03] p-3.5 text-start transition-all duration-200 hover:border-[#6e7aff]/50 hover:bg-white/[0.06] active:scale-[0.98]"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8b96ff]">
                      {question.badge}
                    </span>
                    <Sparkles className="h-3 w-3 text-zinc-500 transition-colors group-hover:text-[#a3aeff]" />
                  </div>
                  <p className="mt-1.5 text-xs font-medium text-zinc-200">{question.title}</p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{question.prompt}</p>
                </button>
              ))}
            </div>

            <p className="mt-6 text-[11px] text-zinc-600">
              {doda.sentences === "ready"
                ? `مبني على DODa: ${formatNumber(doda.sentenceCount)} جملة و ${formatNumber(doda.entryCount)} مدخل معجمي بالحروف العربية.`
                : doda.sentences === "loading"
                  ? "الجمل ديال DODa كيتحمّلو فالخلفية… الـ retrieval غايخدم من بعد."
                  : `مبني على DODa: ${formatNumber(doda.entryCount)} مدخل معجمي بالحروف العربية.`}
            </p>
          </div>
        ) : (
          <div className="relative z-10 mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6 sm:pt-14">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message-enter mb-10 flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "user" ? (
                  <div className="max-w-[86%] rounded-[20px] rounded-ee-md bg-[#202229] px-4 py-3 text-[15px] leading-7 text-zinc-100 sm:max-w-[72%]">
                    {message.document && (
                      <div className="doc-chip mb-2">
                        <FileText className="h-4 w-4 shrink-0 text-[#a3aeff]" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-zinc-100" dir="auto">{message.document.name}</span>
                          <span className="block text-[10px] text-zinc-500">
                            {message.document.pages ? `${message.document.pages} صفحات · ` : ""}
                            {message.document.exercises ? `${message.document.exercises} تمارين · ` : ""}
                            {message.document.analyzed ? "تحلّل كامل" : "النص فقط"}
                          </span>
                        </span>
                      </div>
                    )}
                    <p className="whitespace-pre-wrap" dir="auto">
                      {message.content}
                    </p>
                  </div>
                ) : (
                  <div className="flex w-full max-w-2xl gap-4">
                    <div className="mt-0.5 shrink-0">
                      <VoxLogo size="sm" />
                    </div>
                    <div className="min-w-0 flex-1 pt-1">
                      {message.content ? (
                        <p
                          className="whitespace-pre-wrap text-[15px] leading-8 text-zinc-200 sm:text-base sm:leading-8"
                          dir="auto"
                        >
                          {message.content}
                          {message.status === "streaming" && <span className="streaming-caret" />}
                        </p>
                      ) : message.status === "streaming" ? (
                        <ThinkingBars />
                      ) : (
                        <p className="text-sm leading-7 text-zinc-500">
                          {message.status === "interrupted"
                            ? "الجواب ماكملش. عاود الاتصال وطلب من الأستاذ يكمّل."
                            : "الجواب الصوتي سالا بلا transcription. تقدر تعاود تسمعو."}
                        </p>
                      )}
                      {message.status === "interrupted" && message.content && (
                        <p className="mt-2 text-xs text-amber-200/70">هاد الجواب تقطع قبل ما يكمل.</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        {message.status === "complete" && message.audioChunks?.length ? (
                          <button
                            type="button"
                            onClick={() => replayAudio(message.audioChunks!)}
                            className="replay-button"
                          >
                            <Volume2 className="h-3.5 w-3.5" />
                            عاود سمع الصوت
                          </button>
                        ) : null}
                        {message.refCount ? (
                          <span className="ref-chip" title="جمل أصيلة من Darija Open Dataset تعطات للموديل كمرجع للأسلوب">
                            <BookOpen className="h-3 w-3" />
                            {message.refCount} مراجع من DODa
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </article>
            ))}
            <div ref={conversationEndRef} />
          </div>
        )}
      </section>

      <footer className="composer-area relative z-20 shrink-0 px-4 pb-3 sm:px-6 sm:pb-5">
        <div className="mx-auto max-w-3xl">
          <div className="teaching-toolbar">
            <TeachingSettings preferences={teachingPreferences} onSave={setTeachingPreferences} />
            {messages.length > 0 &&
              HELP_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="help-chip"
                  disabled={connectionStatus !== "connected" || isResponding}
                  onClick={() => submitTurn(chip.prompt, chip.id)}
                >
                  {chip.label}
                </button>
              ))}
            {messages.length > 0 && (
              <select
                aria-label="اختار مساعدة فالتعلّم"
                className="learning-action-select"
                value={tutorAction}
                disabled={connectionStatus !== "connected" || isResponding || (Boolean(input.trim()) && tutorAction === "message")}
                title={input.trim() && tutorAction === "message" ? "صيفط ولا مسح المسودة باش تختار طلب آخر" : "كيحضّر طلب فالرسالة، راجعو ومن بعد صيفطو"}
                onChange={(event) => {
                  const action = event.target.value;
                  if (!isTutorAction(action)) return;
                  setTutorAction(action);
                  const choice = LEARNING_ACTIONS.find((item) => item.id === action);
                  if (choice) setInput(choice.prompt);
                  textareaRef.current?.focus();
                }}
              >
                <option value="message" disabled>بغيت نجرّب...</option>
                {LEARNING_ACTIONS.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
              </select>
            )}
          </div>
          {(error || connectionStatus !== "connected") && (
            <div role="status" className="connection-banner mb-3 flex items-center justify-between gap-4">
              <p className="text-xs text-amber-100/80" dir="auto">
                {error || (connectionStatus === "connecting" ? "كنبداو جلسة جديدة…" : "الجلسة تقطعات.")}
              </p>
              {connectionStatus === "disconnected" && (
                <button type="button" onClick={() => void connect(apiKey)} className="banner-action">
                  <RotateCcw className="h-3 w-3" />
                  عاود الاتصال
                </button>
              )}
              {error && connectionStatus === "connected" && (
                <button type="button" className="icon-button h-7 w-7" onClick={() => setError("")} aria-label="خبّي الرسالة">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          {(activeDocument || docPhase !== "idle" || docStatusText) && (
            <div className="doc-panel mb-3" role="status" aria-live="polite">
              {docPhase === "reading" || docPhase === "analyzing" ? (
                <div className="flex items-center gap-3">
                  <span className="doc-spinner" />
                  <p className="min-w-0 flex-1 truncate text-xs text-zinc-300" dir="auto">{docStatusText}</p>
                  <button type="button" className="icon-button h-7 w-7" onClick={removeDocument} aria-label="وقّف القراءة">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : activeDocument ? (
                <>
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-[#a3aeff]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-zinc-100" dir="auto">
                        {activeDocument.analysis?.title && activeDocument.analysis.title !== "Document"
                          ? activeDocument.analysis.title
                          : activeDocument.fileName}
                      </p>
                      <p className="truncate text-[10px] text-zinc-500" dir="auto">
                        {activeDocument.pageCount ? `${activeDocument.pageCount} صفحات` : activeDocument.fileName}
                        {activeDocument.analysis?.subject && activeDocument.analysis.subject !== "unknown"
                          ? ` · ${activeDocument.analysis.subject}`
                          : ""}
                        {activeDocument.analysis?.exercises.length ? ` · ${activeDocument.analysis.exercises.length} تمارين` : ""}
                      </p>
                    </div>
                    <button type="button" className="icon-button h-7 w-7" onClick={removeDocument} aria-label="حيّد الملف">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {lessonPoints.length > 0 && (
                    <div className="lesson-coverage">
                      <div className="lesson-coverage-row">
                        <div
                          className="lesson-progress"
                          role="progressbar"
                          aria-valuenow={coveredPointIds.length}
                          aria-valuemin={0}
                          aria-valuemax={lessonPoints.length}
                          aria-label={`تقدّم الدرس: ${coveredPointIds.length} من ${lessonPoints.length} نقطة`}
                        >
                          <div
                            className="lesson-progress-fill"
                            style={{ width: `${Math.round((coveredPointIds.length / lessonPoints.length) * 100)}%` }}
                          />
                        </div>
                        <span className="lesson-progress-label">
                          {coveredPointIds.length}/{lessonPoints.length} نقطة
                        </span>
                        <button
                          type="button"
                          className="lesson-plan-toggle"
                          onClick={() => setLessonPlanOpen((open) => !open)}
                          aria-expanded={lessonPlanOpen}
                        >
                          خطة الدرس
                          <ChevronDown className={`h-3 w-3 transition-transform ${lessonPlanOpen ? "rotate-180" : ""}`} />
                        </button>
                      </div>
                      {lessonPlanOpen && (
                        <ol className="lesson-plan-list">
                          {lessonPoints.map((point, index) => {
                            const covered = coveredPointIds.includes(point.id);
                            const isCurrent = currentPointId === point.id;
                            return (
                              <li key={point.id}>
                                <button
                                  type="button"
                                  className={`lesson-plan-item${covered ? " is-covered" : ""}${isCurrent ? " is-current" : ""}`}
                                  onClick={() => jumpToLessonPoint(point)}
                                  disabled={connectionStatus !== "connected" || isResponding}
                                  title={point.summary || point.title}
                                >
                                  <span className="lesson-plan-status" aria-hidden="true">
                                    {covered ? "✓" : isCurrent ? "▶" : "○"}
                                  </span>
                                  <span className="lesson-plan-index">{index + 1}.</span>
                                  <span className="lesson-plan-title" dir="auto">{point.title}</span>
                                  {point.pages && <span className="lesson-plan-pages">p.{point.pages}</span>}
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {lessonPoints.length > 0 && coveredPointIds.length < lessonPoints.length && (
                      <button
                        type="button"
                        className="doc-action doc-action-next"
                        disabled={connectionStatus !== "connected" || isResponding}
                        onClick={teachNextPoint}
                        title="كمّل للنقطة الجاية اللي ما زال ما تشرحاتش"
                      >
                        النقطة الجاية ⏭
                      </button>
                    )}
                    {DOC_ACTIONS.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className="doc-action"
                        disabled={connectionStatus !== "connected" || isResponding}
                        onClick={() => submitTurn(action.prompt, action.id)}
                      >
                        {action.label}
                      </button>
                    ))}
                    {activeDocument.analysis && activeDocument.analysis.exercises.length > 0 && (
                      <select
                        className="doc-action"
                        aria-label="اختار تمرين من الملف"
                        value=""
                        disabled={connectionStatus !== "connected" || isResponding}
                        onChange={(event) => {
                          const exercise = activeDocument.analysis?.exercises[Number(event.target.value)];
                          if (!exercise) return;
                          submitTurn(
                            `يالّاه نبداو بـ ${exercise.id}${exercise.page ? ` (الصفحة ${exercise.page})` : ""}. عاوني نحلّو خطوة بخطوة.`,
                            "doc_exercises",
                          );
                        }}
                      >
                        <option value="" disabled>اختار تمرين…</option>
                        {activeDocument.analysis.exercises.map((exercise, index) => (
                          <option key={`${exercise.id}-${index}`} value={index}>
                            {exercise.id}
                            {exercise.page ? ` · p.${exercise.page}` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {docStatusText && <p className="mt-2 text-[11px] text-amber-200/70" dir="auto">{docStatusText}</p>}
                </>
              ) : (
                <div className="flex items-center gap-3">
                  <p className="min-w-0 flex-1 text-xs text-amber-200/80" dir="auto">{docStatusText}</p>
                  <button
                    type="button"
                    className="icon-button h-7 w-7"
                    onClick={() => {
                      setDocPhase("idle");
                      setDocStatusText("");
                    }}
                    aria-label="خبّي الرسالة"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="composer-wrap">
            <button
              type="button"
              onClick={openFilePicker}
              disabled={connectionStatus !== "connected" || docPhase === "reading" || docPhase === "analyzing"}
              className="attach-button"
              aria-label="رفع PDF"
              title="رفع PDF ديال درس ولا تمارين"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setTutorAction("message");
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={connectionStatus === "connected" ? "كتب سؤالك للأستاذ Vox…" : "عاود الاتصال باش تكمّل…"}
              rows={1}
              disabled={connectionStatus !== "connected"}
              dir="auto"
              className="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-4 py-3.5 text-[15px] leading-7 text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
              aria-label="كتب سؤالك"
            />
            <button
              type="button"
              onClick={continueTurn}
              disabled={!canContinue}
              className="continue-button"
              aria-label="كمّل الشرح"
              title="كمّل الشرح من فين وقفتي — ماشي جواب على السؤال"
            >
              <ChevronsRight className="h-4 w-4" strokeWidth={2.5} />
              <span className="continue-label">كمّل</span>
            </button>
            <button type="button" onClick={sendMessage} disabled={!canSend} className="send-button" aria-label="صيفط">
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
          <p className="mt-2 text-center text-[10px] text-zinc-600">
            Enter باش تصيفط، Shift + Enter لسطر جديد، «كمّل» باش يواصل الشرح من فين وقف. Gemini يقدر يغلط، تأكّد من المعلومات المهمّة.
          </p>
        </div>
      </footer>
    </main>
  );
}
