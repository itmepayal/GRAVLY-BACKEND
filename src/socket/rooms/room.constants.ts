export const ROOMS = {
  user: (userId: string): string => `user:${userId}`,
  session: (sessionId: string): string => `session:${sessionId}`,
  student: (studentId: string): string => `student:${studentId}`,
  cafe: (cafeId: string): string => `cafe:${cafeId}`,
  cafePrivate: (cafeId: string): string => `cafe:private:${cafeId}`,
  order: (orderId: string): string => `order:${orderId}`,
  admin: (): string => "admin",
} as const;
