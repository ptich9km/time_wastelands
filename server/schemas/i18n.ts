import { z } from 'zod';
import { I18nKey } from './common';

export const I18nFileSchema = z.record(I18nKey, z.string().min(1));
export type I18nFile = z.infer<typeof I18nFileSchema>;
