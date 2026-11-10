import type { Binding } from '../sync/model'

export const ACCESS_RECHECK_MS=2*60_000
export const OFFLINE_ACCESS_MS=7*24*60*60_000

export interface AccessLease {
  user_id:string
  project_url:string
  verified_at:number
}

export function allowsOffline(
  binding:Binding|null|undefined,
  lease:AccessLease|undefined,
  cachedBankOwner:unknown,
  projectUrl:string,
  uid:string|null,
  now:number,
) {
  return !!binding && !binding.signed_out && binding.project_url===projectUrl &&
    (!uid || uid===binding.user_id) && cachedBankOwner===binding.user_id &&
    lease?.user_id===binding.user_id && lease.project_url===projectUrl &&
    now>=lease.verified_at && now-lease.verified_at<OFFLINE_ACCESS_MS
}
