/**
 * SANBA デザインシステム（dark + gold / 明朝）。
 * Figma「SANBA — UI/UX 機能拡張デザイン」正本（node 31:2）を下地に、
 * 産婆術の世界観を担う再利用コンポーネント群を 1 か所から提供する。
 *
 * 使い方:
 *   import { Screen, AppHeader, Button, Card, ChatBubble } from "@/components/sanba";
 *
 * 注: 既存の components/ui/*（shadcn light テーマ）とは別系統。
 *     admin/login など light な画面は従来どおり components/ui を使う。
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
export { Button, sanbaButtonVariants } from "./Button";
export type { SanbaButtonProps } from "./Button";
export { Card, CardTitle, CardDescription } from "./Card";
export { Chip } from "./Chip";
export type { ChipProps, ChipTone } from "./Chip";
export { Input, Textarea, Field } from "./Field";
export type { FieldProps } from "./Field";
export { Divider } from "./Divider";
export type { DividerProps } from "./Divider";
export { Avatar } from "./Avatar";
export type { AvatarProps } from "./Avatar";

// 合成・領域コンポーネント
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
export { RequirementCard } from "./RequirementCard";
export type { RequirementCardProps, RequirementStatus } from "./RequirementCard";
export { StatTile } from "./StatTile";
export type { StatTileProps } from "./StatTile";
