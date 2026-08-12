export function slackReviewerAllowed(
  userId: string | undefined,
  configuredIds: string | undefined,
): boolean {
  if (!userId) return false
  return configuredIds
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId) ?? false
}
