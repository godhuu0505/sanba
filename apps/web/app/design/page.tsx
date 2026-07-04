import { CircleCheck, Image as ImageIcon, Mic, Video, Wrench } from "lucide-react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  AppHeader,
  Avatar,
  BottomSheet,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ChatBubble,
  Chip,
  Divider,
  Field,
  Figure,
  InsightCard,
  Input,
  ListRow,
  Logo,
  PhoneFrame,
  RecPill,
  RequirementCard,
  SessionRow,
  StatTile,
  StatusBar,
  VoiceInputBar,
  Waveform,
} from "@/components/sanba";

export const metadata: Metadata = {
  title: "SANBA — UI Kit",
  description: "SANBA デザインシステムのショーケース（白い紙×原色×ステッカー×棒人間 / ADR-0033）。",
};

/**
 * SANBA デザインシステムの生きたカタログ。
 * ADR-0033「白い紙の上の問答」の確定意匠（ステッカー×原色×動く棒人間）を、
 * components/sanba の再利用部品だけで主要画面に組み直し、目視で検証するための開発用ページ。
 */
export default function DesignKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="min-h-screen bg-sanba-surface-strong px-6 py-10 text-sanba-cream">
      <header className="mx-auto mb-8 max-w-6xl">
        <h1 className="sanba-display text-2xl font-bold text-sanba-cream">SANBA UI Kit</h1>
        <p className="mt-1 text-sm text-sanba-muted">
          白い紙×原色×ステッカー×棒人間（ADR-0033）。<code>@/components/sanba</code>{" "}
          の再利用部品で主要画面を再構成。
        </p>
      </header>

      {/* プリミティブ一覧 */}
      <section className="mx-auto mb-10 max-w-6xl rounded-2xl border border-sanba-border bg-sanba-surface p-6">
        <h2 className="mb-4 text-lg font-semibold text-sanba-cream">Primitives</h2>
        <div className="sanba-font flex flex-wrap items-start gap-8 rounded-xl sanba-screen-bg p-6">
          <Stack label="Logo">
            <Logo />
            <Logo size="lg" />
            <Logo wordmark={false} />
          </Stack>
          <Stack label="Button">
            <Button variant="gold">主要 CTA（朱）</Button>
            <Button variant="outline">枠ボタン</Button>
            <Button variant="ghost">テキスト</Button>
            <Button variant="gold" size="sm">
              小
            </Button>
          </Stack>
          <Stack label="Figure（サンバさん）">
            <div className="flex items-end gap-3">
              <Figure state="walking" />
              <Figure state="asking" />
              <Figure state="listening" />
              <Figure state="insight" />
              <Figure state="writing" />
            </div>
          </Stack>
          <Stack label="Chip / tone">
            <Chip tone="gold" dot selected>
              企画(PdM)
            </Chip>
            <Chip tone="neutral">エンジニア</Chip>
            <Chip tone="success" solid>
              承認済み
            </Chip>
            <Chip tone="danger" solid>
              却下
            </Chip>
            <RecPill>12:46</RecPill>
          </Stack>
          <Stack label="Avatar / Waveform">
            <div className="flex items-center gap-2">
              <Avatar tone="agent" glyph="産" />
              <Avatar tone="user" glyph="企" />
            </div>
            <Waveform />
            <Waveform state="muted" />
          </Stack>
          <Stack label="InsightCard（ひらめき）">
            <div className="w-[260px]">
              <InsightCard>並び順は関連度順を要とすると、話が一つに定まりました。</InsightCard>
            </div>
          </Stack>
          <Stack label="Field">
            <div className="w-[240px]">
              <Field label="ゴール（テーマ）" hint="話したいテーマを入力してください">
                <Input placeholder="タップしてテーマを入力…" />
              </Field>
            </div>
          </Stack>
          <Stack label="Divider">
            <div className="w-[240px] space-y-3">
              <Divider />
              <Divider label="または" />
            </div>
          </Stack>
        </div>
      </section>

      {/* 画面再構成 */}
      <section className="mx-auto max-w-6xl">
        <h2 className="mb-4 text-lg font-semibold text-sanba-cream">Screens</h2>
        <div className="flex flex-wrap gap-8">
          <LoginScreen />
          <ConversationScreen />
          <AdminListScreen />
          <ReviewScreen />
        </div>
      </section>
    </main>
  );
}

function Stack({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] uppercase tracking-wide text-sanba-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/* ── 13 ログイン済み（導線）─────────────────────────── */
function LoginScreen() {
  return (
    <PhoneFrame>
      <StatusBar />
      <div className="flex flex-col gap-[18px] px-[16px] pt-[10px]">
        <AppHeader />
        <div className="flex flex-col gap-[6px] pt-[40px]">
          <h2 className="sanba-display text-[24px] font-bold text-sanba-gold-text">
            ようこそ戻られました
          </h2>
          <p className="text-[13px] leading-relaxed text-sanba-muted">
            問答を始めるも、要件を検めるも、御心のままに。
          </p>
        </div>
        <Card>
          <CardTitle>
            <Mic size={18} aria-hidden className="mr-1 inline-block align-[-3px]" />
            SANBA にログイン
          </CardTitle>
          <CardDescription className="text-sanba-cream">
            <CircleCheck size={14} aria-hidden className="mr-1 inline-block align-[-2px]" />
            ログイン中: user@example.com
          </CardDescription>
          <Button variant="gold" block>
            <span className="inline-flex items-center justify-center gap-1.5">
              <Mic size={16} aria-hidden /> インタビューを始める
            </span>
          </Button>
          <Button variant="outline" block>
            <span className="inline-flex items-center justify-center gap-1.5">
              <Wrench size={16} aria-hidden /> 管理画面へ
            </span>
          </Button>
          <Divider />
          <Button variant="ghost" className="self-center">
            ログアウト
          </Button>
        </Card>
      </div>
    </PhoneFrame>
  );
}

/* ── 07 会話（返答＋矛盾検知＋音声ドック）──────────────── */
function ConversationScreen() {
  return (
    <PhoneFrame>
      <StatusBar />
      <AppHeader title="問答" back right={<RecPill>12:46</RecPill>} />
      <div className="flex flex-1 flex-col gap-[12px] px-[16px] pt-[6px]">
        <ChatBubble author="agent">
          結果の並び順は、何を規矩といたしましょう。新しき順か、ゆかりの深き順か。
        </ChatBubble>
        <ChatBubble author="user">関連度順で…いや、さきほど新着順とも申したやも。</ChatBubble>
        <ChatBubble author="agent">その二つ、先ほどより相和しませぬ。いずれを先と。</ChatBubble>
        <div className="mt-auto flex flex-col gap-[12px] pb-[12px]">
          <BottomSheet
            title="緋 — 矛盾を検知"
            actions={
              <>
                <Button variant="gold" block>
                  関連度順にする
                </Button>
                <Button variant="outline" block>
                  新着順にする
                </Button>
              </>
            }
          >
            「関連度順」と「新着順」の両説あり。いずれを規矩とすべきか。
          </BottomSheet>
        </div>
      </div>
      {/* 音声ドックは会話面の底に全幅で敷く（上辺2px墨 / ADR-0033 §7）。 */}
      <VoiceInputBar state="listening" />
    </PhoneFrame>
  );
}

/* ── 91 管理ホーム（セッション一覧）────────────────── */
function AdminListScreen() {
  return (
    <PhoneFrame>
      <StatusBar />
      <AppHeader title="管理の間" back />
      <div className="flex flex-col gap-[12px] px-[16px] pt-[6px]">
        <Button variant="gold" block>
          ＋ セッションを興す
        </Button>
        <p className="pt-[4px] text-[13px] font-bold text-sanba-muted">進行中の問答</p>
        <SessionRow
          title="検索機能の要件インタビュー"
          meta="user@example.com ・ 2026-06-22"
        />
        <SessionRow title="オンボーディング改善" meta="pm@example.com ・ 2026-06-20" />
        <SessionRow title="決済フロー見直し" meta="customer@example.com ・ 2026-06-18" />
        <p className="pt-[8px] text-[13px] font-bold text-sanba-muted">素材を渡す</p>
        <ListRow icon={<ImageIcon size={18} />} title="画像をアップロード" subtitle="PNG / JPG" />
        <ListRow icon={<Video size={18} />} title="動画をアップロード" subtitle="MP4 / MOV" />
      </div>
    </PhoneFrame>
  );
}

/* ── 11 結果（要件絵巻）＋ 93 要件を検める ───────────── */
function ReviewScreen() {
  return (
    <PhoneFrame>
      <StatusBar />
      <AppHeader title="要件を検める" back />
      <div className="flex flex-col gap-[12px] px-[16px] pt-[6px]">
        <div className="flex gap-[8px]">
          <StatTile value="2" label="矛盾解消" />
          <StatTile value="4" label="抜け発見" />
          <StatTile value="6" label="Issue化" />
        </div>
        <InsightCard>
          関連度順を既定と定めたことで、検索体験の軸が一本に通りました。
        </InsightCard>
        <RequirementCard status="draft" confidence="企画 ・ 確度 82%" meta="優先度: must ・ 分類: scope">
          キーワード検索を新設し、無限の巻物で結果を顕す。
        </RequirementCard>
        <RequirementCard
          status="approved"
          confidence="企画 ・ 確度 91%"
          meta="優先度: should ・ 分類: rule"
        >
          並び順は関連度順を既定とし、新着順へ切替可能とする。
        </RequirementCard>
        <RequirementCard
          status="draft"
          confidence="顧客 ・ 確度 64%"
          meta="優先度: should ・ 分類: scope"
          showActions
        >
          「該当なし」の空の景色を設える。
        </RequirementCard>
        <Button variant="gold" block>
          ⎘ GitHub Issue を奉る（6件）
        </Button>
      </div>
    </PhoneFrame>
  );
}
