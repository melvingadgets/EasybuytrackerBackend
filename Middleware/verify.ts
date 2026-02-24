import jwt from "jsonwebtoken";

export const verifyToken:any = async (req: any, res: any, next: any) => {
  const authHeader = req.headers["authorization"] as string | undefined;
  const cookieHeader = req.headers["cookie"] as string | undefined;

  let token = "";
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1] || "";
  } else if (cookieHeader) {
    const sessionCookie = cookieHeader
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("sessionId="));
    token = sessionCookie?.split("=")[1] || "";
  }

  if (!token) {
    return res.status(401).json({
      message: "please login to get token",
    });
  }

  jwt.verify(token, "variationofeventsisatrandom", (err: any, payload: any) => {
    if (err) {
      return res.status(401).json({ message: "token expire" });
    }
    req.user = payload;
    next();
  });
};

export const requireRole =
  (allowedRoles: Array<"Admin" | "User">) =>
  (req: any, res: any, next: any) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }
    next();
  };
