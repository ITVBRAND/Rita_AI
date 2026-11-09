CREATE TABLE "PrivateChatAccess" (
    "userId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateChatAccess_pkey" PRIMARY KEY ("userId")
);
