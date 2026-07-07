/**
 * SANBA デザインシステム（白い紙×原色×ステッカー×動く棒人間 / ADR-0033）。
 * 「白い紙の上の問答」——紙色の下地に墨の線、行動=朱・選択=瑠璃・ひらめき=山吹の
 * 原色アクセントで、産婆術の世界観を担う再利用コンポーネント群を 1 か所から提供する。
 *
 * 使い方:
 *   import { Screen, AppHeader, Button, Card, ChatBubble } from "@/components/sanba";
 *
 * 注: 既存の components/ui/*（shadcn light テーマ）とは別系統。
 *     admin/login など従来 light な画面は components/ui を使う（トーンは本系統と地続き）。
 */

// 文脈・レイアウト
export { Screen, PhoneFrame } from "./Screen";
export type { ScreenProps, PhoneFrameProps } from "./Screen";
export { StatusBar } from "./StatusBar";
export type { StatusBarProps } from "./StatusBar";
export { AppHeader } from "./AppHeader";
export type { AppHeaderProps } from "./AppHeader";

// 基本プリミティブ
export { Logo } from "./Logo";
export type { LogoProps } from "./Logo";
export { BrandMark } from "./BrandMark";
export { BrandSplash } from "./BrandSplash";
export type { BrandSplashProps } from "./BrandSplash";
export { Button, sanbaButtonVariants } from "./Button";
export type { SanbaButtonProps } from "./Button";
export { Card, CardTitle, CardDescription } from "./Card";
export { Chip } from "./Chip";
export type { ChipProps, ChipTone } from "./Chip";
export { Input, Textarea, Select, Field } from "./Field";
export type { FieldProps } from "./Field";
export { Divider } from "./Divider";
export type { DividerProps } from "./Divider";
export { Avatar } from "./Avatar";
export type { AvatarProps } from "./Avatar";
export { Figure } from "./Figure";
export type { FigureProps, FigureState } from "./Figure";
export { Parade } from "./Parade";
export type { ParadeProps } from "./Parade";
export { RecPill } from "./RecPill";
export type { RecPillProps } from "./RecPill";

// 合成・領域コンポーネント
export { Marquee } from "./Marquee";
export type { MarqueeProps } from "./Marquee";
export { ChatBubble } from "./ChatBubble";
export type { ChatBubbleProps } from "./ChatBubble";
export { Waveform } from "./Waveform";
export type { WaveformProps } from "./Waveform";
export { VoiceInputBar } from "./VoiceInputBar";
export type { VoiceInputBarProps } from "./VoiceInputBar";
export { BottomSheet } from "./BottomSheet";
export type { BottomSheetProps } from "./BottomSheet";
export { ListRow } from "./ListRow";
export type { ListRowProps } from "./ListRow";
export { SessionRow } from "./SessionRow";
export type { SessionRowProps } from "./SessionRow";
export { SessionHistoryList } from "./SessionHistoryList";
export type { SessionHistoryItem, SessionHistoryListProps } from "./SessionHistoryList";
export { RequirementCard } from "./RequirementCard";
export type { RequirementCardProps, RequirementStatus } from "./RequirementCard";
export { InsightCard } from "./InsightCard";
export type { InsightCardProps } from "./InsightCard";
export { StatTile } from "./StatTile";
export type { StatTileProps } from "./StatTile";
