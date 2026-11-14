import type { Cue, Variation } from './analysis';
import type { FailureKey } from './tracker';

export const VAR_LABEL: Record<Variation, string> = {
  tuck: 'Tuck', advTuck: 'Advanced tuck', oneLeg: 'One leg', halfLay: 'Half lay', straddle: 'Straddle', full: 'Full',
};

export const CUE_LABEL: Record<Exclude<Cue, null>, string> = {
  raise: 'הרם את האגן – הגוף מתחת לאופק',
  lower: 'הגוף גבוה מדי – הורד לאופק',
  pike: 'פתח את האגן – הישבן שוקע',
  arch: 'הגב מקושת – אסוף בטן',
  elbows: 'יישר מרפקים',
  knees: 'יישר ברכיים',
};

export const FAILURE_LABEL: Record<FailureKey, string> = {
  drop: 'כל הגוף ירד מתחת לאופק',
  pike: 'האגן התקפל (הישבן שקע)',
  arch: 'הגב התקשת',
  elbows: 'המרפקים התכופפו',
  knees: 'הברכיים התכופפו',
  none: 'הצורה נשמרה עד הסוף',
};

export const FAILURE_HINT: Record<FailureKey, string> = {
  drop: 'רמז: כוח משיכה ביד ישרה – lats והורדת שכמות. תרגילים: front lever raises, נגטיבים, scapular pulls.',
  pike: 'רמז: ליבה וישבן לא מחזיקים קו ישר. תרגילים: dragon flag, hollow body, hip thrust / glute bridge.',
  arch: 'רמז: שליטת בטן (posterior pelvic tilt). תרגילים: hollow body hold, hanging leg raises.',
  elbows: 'רמז: כוח ביד ישרה – הזרועות מפצות על ה-lats. תרגילים: straight-arm pulldown, וריאציה קלה יותר עם מרפקים נעולים.',
  knees: 'רמז: מקצרים את המנוף כדי להקל. חזור לווריאציה קלה יותר עם רגליים נעולות.',
  none: 'לא זוהתה שבירת צורה – כנראה אחיזה/סיבולת כללית, או שירדת מרצון.',
};

export const fmtTime = (s: number) => s.toFixed(1) + '″';
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
