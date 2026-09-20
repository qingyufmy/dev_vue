import { z } from 'zod'
export const personalPreferencesSchema = z.object({ analysis:z.enum(['off','effective','all']),decision:z.enum(['off','effective','all']),analysisSound:z.enum(['off','bell','chime','pulse']),decisionSound:z.enum(['off','bell','chime','pulse']),feishuEnabled:z.boolean(),emailEnabled:z.boolean() })
export const personalSettingsSchema = z.object({ nickname:z.string(),preferences:personalPreferencesSchema,hasFeishu:z.boolean(),emailAvailable:z.boolean(),revision:z.number() })
export const personalSettingsResponseSchema = z.object({data:personalSettingsSchema})
export const personalSaveResponseSchema = z.object({data:z.object({revision:z.number()})})
export const personalInboxResponseSchema = z.object({data:z.object({unread:z.number(),items:z.array(z.object({id:z.string(),kind:z.enum(['analysis','decision']),resourceId:z.string(),title:z.string(),summary:z.string(),actionable:z.boolean(),createdAt:z.string(),read:z.boolean()}))})})
export const personalReadResponseSchema = z.object({data:z.object({read:z.boolean()})})
export type PersonalSettings = z.infer<typeof personalSettingsSchema>
export type PersonalInbox = z.infer<typeof personalInboxResponseSchema>['data']
