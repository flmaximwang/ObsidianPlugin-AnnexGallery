/**
 * 「从预设创建」的素材：新格式的元数据预设（JSON + 正文 `.md`）。
 *
 * 这些只是**素材**，不是运行时默认值 —— 运行时只认设置里登记的外部文件；没有登记就报错，
 * 不静默回退（沿用 2.0 的冻结口径）。创建时写两份文件：
 * `AnnexGalleryTemplates/<id>.json` 与同目录的正文 `.md`，并把 JSON 里的 `template`
 * 改成实际写入的正文路径（`createVaultFile` 遇到重名会加序号）。
 */
import tecnaitemProfile from "../defaults/presets/tecnaitem.json";
import minimalProfile from "../defaults/presets/minimal.json";
import tecnaitemBody from "../defaults/presets/tecnaitem.body.md";
import tecnaitemEmbedBody from "../defaults/presets/tecnaitem-embed.body.md";
import minimalBody from "../defaults/presets/minimal.body.md";
import type { ParseProfile } from "./profiles";

export interface ProfilePreset {
  /** 选择值 / 建议文件名（不含扩展名）。 */
  id: string;
  /** 下拉里显示的名字。 */
  name: string;
  /** JSON 内容（`template` 是建议路径；实际写入时按真实路径改写）。 */
  profile: ParseProfile;
  /** 正文模板原文；有就同时写出一份 `.md`。 */
  body?: string;
}

/** JSON 原文 → 预设对象（深拷贝，调用方改了也不会污染素材）。 */
function material(profile: unknown, template: string): ParseProfile {
  return { ...(profile as ParseProfile), template };
}

export const PRESET_PROFILES: ProfilePreset[] = [
  {
    id: "tecnaitem",
    name: "TECNAI 电镜（默认正文）",
    profile: material(tecnaitemProfile, "AnnexGalleryTemplates/tecnaitem.md"),
    body: tecnaitemBody,
  },
  {
    id: "tecnaitem-embed",
    name: "TECNAI 电镜（嵌入缩略图）",
    profile: { ...material(tecnaitemProfile, "AnnexGalleryTemplates/tecnaitem-embed.md"), id: "tecnaitem-embed" },
    body: tecnaitemEmbedBody,
  },
  {
    id: "minimal",
    name: "最小示例（<序号>）",
    profile: material(minimalProfile, "AnnexGalleryTemplates/minimal.md"),
    body: minimalBody,
  },
];

/** 预设的 JSON 原文：`template` 换成实际写入的正文路径；没有正文就留空。 */
export function presetJsonText(preset: ProfilePreset, templatePath: string): string {
  const profile: ParseProfile = { ...preset.profile, template: templatePath };
  return `${JSON.stringify(profile, null, 2)}\n`;
}
