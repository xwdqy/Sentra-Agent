import { tag, fmt } from './xmlUtils.js';

type ThresholdPair = {
  low?: number;
  high?: number;
};

type ValenceBands = {
  negative_max?: number;
  positive_min?: number;
};

type StressBands = {
  low_max?: number;
  medium_max?: number;
};

type Thresholds = {
  IE_A?: ThresholdPair;
  SN_VSTD?: ThresholdPair;
  TF_POS?: ThresholdPair;
  JP_ASTD?: ThresholdPair;
  POS_V_CUT?: number;
  NEG_V_CUT?: number;
  VALENCE_BANDS?: ValenceBands;
  STRESS_BANDS?: StressBands;
};

type EmotionItem = {
  label?: string;
  score?: number;
};

type MbtiDim = {
  axis?: string;
  letter?: string;
  value?: number;
  metric?: string;
};

type MbtiData = {
  type?: string;
  confidence?: number;
  dimensions?: MbtiDim[];
  dominant_emotion?: string;
};

type UserAggregate = {
  top_emotions?: EmotionItem[];
  mbti?: MbtiData;
  thresholds?: Thresholds;
  total_events?: number;
  avg_valence?: number;
  avg_arousal?: number;
  avg_dominance?: number;
  avg_stress?: number;
  v_std?: number;
  a_std?: number;
  d_std?: number;
  pos_ratio?: number;
  neg_ratio?: number;
};

function takeFirst<T>(items: T[], limit: number): T[] {
  if (!Array.isArray(items) || limit <= 0) return [];
  const out: T[] = [];
  for (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function thresholdsXML(th: Thresholds | null | undefined): string {
  if (!th || typeof th !== 'object') return '';
  const parts: string[] = [];
  const pair = (name: string, obj: ThresholdPair | undefined) => {
    if (!obj) return '';
    return `<${name}>${tag('low', obj.low)}${tag('high', obj.high)}</${name}>`;
  };
  parts.push(pair('IE_A', th.IE_A));
  parts.push(pair('SN_VSTD', th.SN_VSTD));
  parts.push(pair('TF_POS', th.TF_POS));
  parts.push(pair('JP_ASTD', th.JP_ASTD));
  parts.push(tag('POS_V_CUT', th.POS_V_CUT));
  parts.push(tag('NEG_V_CUT', th.NEG_V_CUT));
  if (th.VALENCE_BANDS && typeof th.VALENCE_BANDS === 'object') {
    const vb = th.VALENCE_BANDS;
    parts.push(`<VALENCE_BANDS>${tag('negative_max', vb.negative_max)}${tag('positive_min', vb.positive_min)}</VALENCE_BANDS>`);
  }
  if (th.STRESS_BANDS && typeof th.STRESS_BANDS === 'object') {
    const sb = th.STRESS_BANDS;
    parts.push(`<STRESS_BANDS>${tag('low_max', sb.low_max)}${tag('medium_max', sb.medium_max)}</STRESS_BANDS>`);
  }
  return `<thresholds>${parts.join('')}</thresholds>`;
}

export function topEmotionsString(list: EmotionItem[] | null | undefined, n: number = 6): string {
  try {
    const filtered = Array.isArray(list)
      ? list.filter((e) => String(e?.label).toLowerCase() !== 'neutral')
      : [];
    const arr = takeFirst(filtered, n);
    return arr.map((e) => `${e.label}:${fmt(e.score)}`).join(', ');
  } catch { return ''; }
}

export function dimsText(mbti: MbtiData | null | undefined): string {
  try {
    const dims = Array.isArray(mbti?.dimensions) ? mbti.dimensions : [];
    return dims.map((d) => `${d.axis}:${d.letter}(${fmt(d.value)}|${d.metric})`).join(', ');
  } catch { return ''; }
}

export function buildSentraEmoSection(ua: unknown): string {
  if (!ua || typeof ua !== 'object') return '';
  const data = ua as UserAggregate;
  const aggTop = topEmotionsString(data.top_emotions, 6);
  const mb = data.mbti || {};
  const th = data.thresholds || {};
  const summary = [
    tag('total_events', data.total_events),
    tag('avg_valence', fmt(data.avg_valence)),
    tag('avg_arousal', fmt(data.avg_arousal)),
    tag('avg_dominance', fmt(data.avg_dominance)),
    tag('avg_stress', fmt(data.avg_stress)),
    tag('v_std', fmt(data.v_std)),
    tag('a_std', fmt(data.a_std)),
    tag('d_std', fmt(data.d_std)),
    tag('pos_ratio', fmt(data.pos_ratio)),
    tag('neg_ratio', fmt(data.neg_ratio)),
    tag('agg_top_emotions', aggTop || '(none)')
  ].join('');
  const mbtiParts = [
    tag('type', mb.type || ''),
    tag('confidence', fmt(mb.confidence)),
    tag('dims', dimsText(mb) || '')
  ];
  if (mb.dominant_emotion && String(mb.dominant_emotion).toLowerCase() !== 'neutral') {
    mbtiParts.push(tag('dominant_emotion', mb.dominant_emotion));
  }
  const mbti = mbtiParts.join('');
  const cmp = (() => {
    const blocks = [];
    if (th.IE_A) blocks.push(`<avg_arousal_vs_IE_A>${tag('value', fmt(data.avg_arousal))}${tag('low', th.IE_A.low)}${tag('high', th.IE_A.high)}</avg_arousal_vs_IE_A>`);
    if (th.SN_VSTD) blocks.push(`<v_std_vs_SN_VSTD>${tag('value', fmt(data.v_std))}${tag('low', th.SN_VSTD.low)}${tag('high', th.SN_VSTD.high)}</v_std_vs_SN_VSTD>`);
    if (th.TF_POS) blocks.push(`<pos_ratio_vs_TF_POS>${tag('value', fmt(data.pos_ratio))}${tag('low', th.TF_POS.low)}${tag('high', th.TF_POS.high)}</pos_ratio_vs_TF_POS>`);
    if (th.JP_ASTD) blocks.push(`<a_std_vs_JP_ASTD>${tag('value', fmt(data.a_std))}${tag('low', th.JP_ASTD.low)}${tag('high', th.JP_ASTD.high)}</a_std_vs_JP_ASTD>`);
    if (th.VALENCE_BANDS) {
      const vb = th.VALENCE_BANDS;
      blocks.push(`<avg_valence_vs_VALENCE_BANDS>${tag('value', fmt(data.avg_valence))}${tag('negative_max', vb.negative_max)}${tag('positive_min', vb.positive_min)}</avg_valence_vs_VALENCE_BANDS>`);
    }
    if (th.STRESS_BANDS) {
      const sb = th.STRESS_BANDS;
      blocks.push(`<avg_stress_vs_STRESS_BANDS>${tag('value', fmt(data.avg_stress))}${tag('low_max', sb.low_max)}${tag('medium_max', sb.medium_max)}</avg_stress_vs_STRESS_BANDS>`);
    }
    return `<compare>${blocks.join('')}</compare>`;
  })();
  return `<sentra-emo>${tag('summary', summary)}<mbti>${mbti}</mbti>${thresholdsXML(th)}${cmp}</sentra-emo>`;
}
