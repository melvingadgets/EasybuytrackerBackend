import UserModel from "../Model/UserModel.js";
import {type Response, type Request} from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import EasyBoughtItemModel from "../Model/EasyBoughtitem.js";

const IPHONE_IMAGE_URLS: Record<string, string> = {
  "iPhone XR": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xr-new.jpg",
  "iPhone XS": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xs-new.jpg",
  "iPhone XS Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-xs-max-new1.jpg",
  "iPhone 11": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11.jpg",
  "iPhone 11 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11-pro.jpg",
  "iPhone 11 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-11-pro-max.jpg",
  "iPhone 12": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12.jpg",
  "iPhone 12 mini": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-mini.jpg",
  "iPhone 12 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-pro--.jpg",
  "iPhone 12 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-12-pro-max-.jpg",
  "iPhone 13": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13.jpg",
  "iPhone 13 mini": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-mini.jpg",
  "iPhone 13 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-pro.jpg",
  "iPhone 13 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-13-pro-max.jpg",
  "iPhone 14": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14.jpg",
  "iPhone 14 Plus": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-plus.jpg",
  "iPhone 14 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-pro.jpg",
  "iPhone 14 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-14-pro-max.jpg",
  "iPhone 15": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15.jpg",
  "iPhone 15 Plus": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-plus-.jpg",
  "iPhone 15 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-pro.jpg",
  "iPhone 15 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-15-pro-max.jpg",
  "iPhone 16": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16.jpg",
  "iPhone 16 Plus": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-plus.jpg",
  "iPhone 16 Pro": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-pro.jpg",
  "iPhone 16 Pro Max": "https://fdn2.gsmarena.com/vv/bigpic/apple-iphone-16-pro-max.jpg",
  "iPhone 17": "https://placehold.co/600x600?text=iPhone+17",
  "iPhone 17 Pro": "https://placehold.co/600x600?text=iPhone+17+Pro",
  "iPhone 17 Pro Max": "https://placehold.co/600x600?text=iPhone+17+Pro+Max",
};

const WEEKLY_ONLY_MODELS = new Set([
  "iPhone XR",
  "iPhone XS",
  "iPhone XS Max",
  "iPhone 11",
  "iPhone 11 Pro",
  "iPhone 11 Pro Max",
]);

const SIXTY_PERCENT_DOWNPAYMENT_MODELS = new Set([
  "iPhone XR",
  "iPhone XS",
  "iPhone XS Max",
  "iPhone 17",
  "iPhone 17 Pro",
  "iPhone 17 Pro Max",
]);



export const CreateAdmin = async (req: Request, res: Response) => {
  const checkrole = req.user?.role;
  if (checkrole !== "Admin") {
    return res.status(403).json({
      message: "You are not authorized to create admin",
    });
  }
  try {
    const { firstName, email, lastName, fullName, Password } = req.body;
    const normalizedFullName = fullName?.trim() || `${firstName || ""} ${lastName || ""}`.trim();
    if (!normalizedFullName || !email || !Password) {
      return res.status(401).json({
        message: "All fields required",
      });
    }
    const CheckEmail = await UserModel.findOne({ email: email });
    if (CheckEmail) {
      return res.status(401).json({
        message: "Email Already in use",
      });
    }
    if (Password.length < 8) {
      return res.status(401).json({
        message: "password must not be less than eight characters",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const HashedPassword = await bcrypt.hash(Password, salt);
    const UserData = await UserModel.create({
      fullName: normalizedFullName,
      email: email,
      password: HashedPassword,
      role: "Admin",
    });

 return res.status(200).json({
      message: "registration was successful",
      success: 1,
      Result: {
        _id: UserData._id,
        fullName: UserData.fullName,
        email: UserData.email,
        role: UserData.role,
      },
    });
     } catch (error: any) {
    res.status(400).json({
      message: "unable to create user",
      Reason: error.message,
    });
  }
};

// export const LoginAdmin = async (
//   req: Request,
//   res: Response
// ): Promise<Response> => {
//   try {
//     const { email, password } = req.body;
//     const checkEmail = await UserModel.findOne({ Email: email }).lean();

//     if (checkEmail) {
//       const CheckPassword = await bcrypt.compare(password, checkEmail.password);

//       if (CheckPassword) {
//         if (checkEmail) {
//           const token = jwt.sign(
//             {
//               _id: checkEmail?._id,
//               userName: checkEmail.firstName + " " + checkEmail.lastName,
//               role: checkEmail.role,
//             },
//             "variationofeventsisatrandom",
//             { expiresIn: "40m" }
//           );
//           //  console.log("Melasi", token);
//           // const { password, ...info } = checkEmail._doc;
//           res.cookie("sessionId", token);
//           // console.log(req.headers["cookie"]);

//           return res.status(201).json({
//             success: 1,
//             message: "login successful",
//             data:token ,
//           });
//         }
//         return res.status(404).json({
//           message: "Access denied",
//         });
//       } else {
//         return res.status(404).json({
//           message: "Password is incorrect",
//         });
//       }
//     } else {
//       return res.status(404).json({
//         message: "user does not exist",
//       });
//     }
//   } catch (error: any) {
//     return res.status(404).json({
//       message: `unable to login because ${error}`,
//     });
//   } 
// };
export const LoginUser = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { email, password } = req.body;
    const checkEmail = await UserModel.findOne({ email: email }).select("+password").lean();

    if (checkEmail) {
      const CheckPassword = await bcrypt.compare(password, String(checkEmail.password));

      if (CheckPassword) {
        if (checkEmail) {
          const token = jwt.sign(
            {
              _id: checkEmail?._id,
              userName: checkEmail.fullName,
              role: checkEmail.role,
              email: checkEmail.email,
            },
            "variationofeventsisatrandom",
            { expiresIn: "40m" }
          );
          //  console.log("Melasi", token);
          // const { password, ...info } = checkEmail._doc;
          res.cookie("sessionId", token);
          // console.log(req.headers["cookie"]);

          return res.status(201).json({
            success: 1,
            message: "login successful",
            data:token ,
          });
        }
        return res.status(404).json({
          message: "Access denied",
        });
      } else {
        return res.status(404).json({
          message: "Password is incorrect",
        });
      }
    } else {
      return res.status(404).json({
        message: "user does not exist",
      });
    }
  } catch (error: any) {
    return res.status(404).json({
      message: `unable to login because ${error}`,
    });
  } 
};
export const CreateUser = async (req: Request, res: Response) => {
const checkrole = req.user?.role;
if(checkrole !== "Admin"){
  return res.status(404).json({
    message: "You are not authorized to create user",
  });
}
  try {
    const { firstName, email, lastName, fullName, Password } = req.body;
    const normalizedFullName = fullName?.trim() || `${firstName || ""} ${lastName || ""}`.trim();
    if (!normalizedFullName || !email || !Password) {
      return res.status(401).json({
        message: "All fields required",
      });
    }
    const CheckEmail = await UserModel.findOne({ email: email });
    if (CheckEmail) {
      return res.status(401).json({
        message: "Email Already in use",
      });
    }
    if (Password.length < 8) {
      return res.status(401).json({
        message: "password must not be less than eight characters",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const HashedPassword = await bcrypt.hash(Password, salt);
    const UserData = await UserModel.create({
      fullName: normalizedFullName,
      email: email,
      password: HashedPassword,
      role: "User",
    });

 return res.status(200).json({
      message: "registration was successful",
      success: 1,
      Result: {
        _id: UserData._id,
        fullName: UserData.fullName,
        email: UserData.email,
        role: UserData.role,
      },
    });
     } catch (error: any) {
    res.status(400).json({
      message: "unable to create user",
      Reason: error.message,
    });
  }
};


export const  GetEasyBoughtItems = async (req: Request, res: Response) => {
try {
      const userEmail = req.user?.email;
      if (!userEmail) {
        return res.status(401).json({
          message: "Access denied",
        });
      }
      const checkuser = await UserModel.findOne({ email: userEmail });
      if(checkuser){
        const userId = checkuser._id;
        const easyBoughtItems = await EasyBoughtItemModel.find({UserId:userId}).lean();
        const normalizedItems = easyBoughtItems.map((item: any) => ({
          ...item,
          PhonePrice: item.PhonePrice ?? item.TotalPrice ?? 0,
        }));
        return res.status(200).json({
          message: "EasyBoughtItems retrieved successfully",
          data: normalizedItems,
        });
      } else {
        return res.status(404).json({
          message: "User not found",
        });
      }
    }
      catch (error) {
  return res.status(404).json({
    message: "Access denied",
  });
}}

export const GetAllUsers = async (req: Request, res: Response) => {
  
    try {
      const checkrole = req.user?.role;  
    if (checkrole !== "Admin") {
      return res.status(404).json({
        message: "Access denied",
      });
    }
    else{
      const users = await UserModel.find().select("-password");
      return res.status(200).json({
        message: "Users retrieved successfully",
        data: users,
      });
    }
    } catch (error) {
      return res.status(404).json({
        message: "Access denied",
      });
    }
}
export const CreateEasyBoughtItem = async (req: Request, res: Response) => {
    const checkrole = req.user?.role;  
    if (checkrole !== "Admin") {
      return res.status(404).json({
        message: "Access denied",
      });
    }

    try {
      const CheckUseremail = req.user?.email;
    if (!CheckUseremail) {
      return res.status(401).json({
        message: "Access denied",
      });
    }
    const CheckRole = await UserModel.findOne({email:CheckUseremail});

    if(CheckRole?.role !== "Admin"){

      return res.status(404).json({
        message: "Access denied",
      });
    }
   
   

    const { IphoneModel, ItemName, Plan, PhonePrice, TotalPrice, monthlyPlan, weeklyPlan, UserEmail } = req.body;
    const resolvedIphoneModel = String(IphoneModel || ItemName || "").trim();
    const resolvedUserEmail = String(UserEmail || req.user?.email || "").trim();
    if (
      !resolvedIphoneModel ||
      (PhonePrice === undefined && TotalPrice === undefined) ||
      !resolvedUserEmail
    ) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    if (!Object.prototype.hasOwnProperty.call(IPHONE_IMAGE_URLS, resolvedIphoneModel)) {
      return res.status(400).json({
        message: "Unsupported iPhone model",
      });
    }

    const resolvedPhonePrice = PhonePrice ?? TotalPrice;
    const phonePriceNumber = Number(resolvedPhonePrice);
    if (!Number.isFinite(phonePriceNumber) || phonePriceNumber <= 0) {
      return res.status(400).json({
        message: "PhonePrice must be greater than zero",
      });
    }

    const isWeeklyOnly = WEEKLY_ONLY_MODELS.has(resolvedIphoneModel);
    const resolvedPlan = isWeeklyOnly ? "Weekly" : Plan;

    if (!["Monthly", "Weekly"].includes(resolvedPlan)) {
      return res.status(400).json({
        message: "Plan must be Monthly or Weekly",
      });
    }

    const monthlyPlanNumber = Number(monthlyPlan);
    const weeklyPlanNumber = Number(weeklyPlan);

    if (resolvedPlan === "Monthly" && ![1, 2, 3].includes(monthlyPlanNumber)) {
      return res.status(400).json({
        message: "monthlyPlan must be 1, 2, or 3 for Monthly plan",
      });
    }

    if (resolvedPlan === "Weekly" && ![4, 8, 12].includes(weeklyPlanNumber)) {
      return res.status(400).json({
        message: "weeklyPlan must be 4, 8, or 12 for Weekly plan",
      });
    }

    const getUser = await UserModel.findOne({email:resolvedUserEmail});
    if(!getUser){
      return res.status(404).json({
        message: "User does not exist",
      });
    }

    const downPaymentMultiplier = SIXTY_PERCENT_DOWNPAYMENT_MODELS.has(resolvedIphoneModel) ? 0.6 : 0.4;
    const downPayment = phonePriceNumber * downPaymentMultiplier;
    const loanedAmount = phonePriceNumber - downPayment;
    
    const CheckUserInEaseBought=await EasyBoughtItemModel.findOne({UserEmail:UserEmail});
    if(CheckUserInEaseBought){
      return res.status(409).json({
        message: "first pay your money finish bros 😒",
      });
    }

    const easyBoughtPayload: Record<string, any> = {
      IphoneModel: resolvedIphoneModel,
      IphoneImageUrl: IPHONE_IMAGE_URLS[resolvedIphoneModel],
      Plan: resolvedPlan,
      downPayment,
      loanedAmount,
      PhonePrice: phonePriceNumber,
      UserEmail: resolvedUserEmail,
      UserId:getUser._id,
    };

    if (resolvedPlan === "Monthly") {
      easyBoughtPayload.monthlyPlan = monthlyPlanNumber;
    } else {
      easyBoughtPayload.weeklyPlan = weeklyPlanNumber;
    }

    const easyBoughtItem = await EasyBoughtItemModel.create(easyBoughtPayload);

    return res.status(200).json({
      message: "EasyBoughtItem created successfully",
      data: easyBoughtItem,
    });
    } catch (error) {
      return res.status(400).json({
        message: "Failed to create EasyBoughtItem",
        error: error instanceof Error ? error.message : "Unknown error occurred", 
      });
    }
  } 

  export const LogoutUser = async (req: Request, res: Response) => {


    try {
      res.clearCookie("sessionId");
      return res.status(200).json({
        message: "Logout successful",
      });
    } catch (error) {
      return res.status(400).json({
        message: "Failed to logout",
        error: error instanceof Error ? error.message : "Unknown error occurred", 
      });
    }
  }   
 export const GetCurrentUser = async (req: Request, res: Response) => {
try {
  const user = req.user;
  return res.status(200).json({
    message: "Current user retrieved successfully",
    data: user,
  });
} catch (error) {
  return res.status(400).json({
    message: "Failed to retrieve current user",
    error: error instanceof Error ? error.message : "Unknown error occurred", 
  }); 
}

 }
