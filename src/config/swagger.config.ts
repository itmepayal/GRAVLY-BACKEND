import path from "path";
import swaggerJsdoc from "swagger-jsdoc";

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Gravil Cafe API",
      version: "1.0.0",
      description:
        "APIs for Student, Cafe Owner and a single Admin (authentication, cafe management and menu management).",
    },
    servers: [{ url: "http://localhost:8000/api/v1", description: "API v1" }],
    tags: [
      {
        name: "Authentication",
        description:
          "Student, Cafe Owner and Admin login / signup, token refresh and logout",
      },
      {
        name: "Cafes - Public",
        description: "Approved cafes visible to students (no login needed)",
      },
      {
        name: "Cafes - Owner",
        description: "Cafe application and cafe management for cafe owners",
      },
      {
        name: "Cafes - Admin",
        description: "Admin review of cafe applications (approve / reject)",
      },
      {
        name: "Menu - Owner",
        description:
          "Menu items and stock management for cafe owners (cafe must be approved)",
      },
      {
        name: "Menu - Public",
        description: "Cafe menu visible to students (no login needed)",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        /* ---------------- COMMON ---------------- */
        Error: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Something went wrong" },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            total: { type: "integer", example: 42 },
            page: { type: "integer", example: 1 },
            limit: { type: "integer", example: 10 },
            pages: { type: "integer", example: 5 },
          },
        },
        FileObject: {
          type: "object",
          properties: {
            url: {
              type: "string",
              example:
                "https://res.cloudinary.com/demo/image/upload/sample.jpg",
            },
            publicId: { type: "string", example: "cafes/665f/public/abc123" },
          },
        },
        Rating: {
          type: "object",
          properties: {
            average: { type: "number", example: 4.3 },
            count: { type: "integer", example: 128 },
          },
        },
        ApprovalStatus: {
          type: "string",
          enum: ["pending", "approved", "rejected"],
        },

        /* ---------------- USER ---------------- */
        User: {
          type: "object",
          properties: {
            id: { type: "string", example: "665f1c2e9b1d8a0012a4b5c6" },
            name: { type: "string", example: "Riya Patel" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["student", "cafeOwner", "admin"] },
            profileImage: { type: "string", nullable: true },
            authProvider: {
              type: "string",
              enum: ["google", "apple", "password"],
            },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Login successful" },
            data: {
              type: "object",
              properties: {
                accessToken: { type: "string" },
                refreshToken: { type: "string" },
                tokenType: { type: "string", example: "Bearer" },
                user: { $ref: "#/components/schemas/User" },
              },
            },
          },
        },

        /* ---------------- CAFE: PUBLIC ---------------- */
        CafePublicSummary: {
          type: "object",
          properties: {
            _id: { type: "string", example: "665f1c2e9b1d8a0012a4b5c6" },
            name: { type: "string", example: "Brew & Bites" },
            description: { type: "string" },
            logo: { type: "string" },
            coverImage: { $ref: "#/components/schemas/FileObject" },
            city: { type: "string", example: "Ahmedabad" },
            address: { type: "string" },
            landmark: { type: "string" },
            rating: { $ref: "#/components/schemas/Rating" },
            isOpen: { type: "boolean" },
            deliveryEnabled: { type: "boolean" },
            pickupEnabled: { type: "boolean" },
            deliveryFee: { type: "number", example: 20 },
            platformFee: { type: "number", example: 5 },
          },
        },
        CafePublicDetail: {
          allOf: [
            { $ref: "#/components/schemas/CafePublicSummary" },
            {
              type: "object",
              properties: {
                galleryImages: {
                  type: "array",
                  items: { $ref: "#/components/schemas/FileObject" },
                },
                state: { type: "string", example: "Gujarat" },
                pincode: { type: "string", example: "380001" },
              },
            },
          ],
        },

        /* ---------------- CAFE: OWNER ---------------- */
        CafeApplicationInput: {
          type: "object",
          required: [
            "name",
            "contactNumber",
            "email",
            "aadhaarNumber",
            "address",
            "city",
            "state",
            "pincode",
            "panNumber",
            "fssaiNumber",
            "accountHolderName",
            "accountNumber",
            "ifscCode",
            "panCardFront",
            "identityFront",
            "foodLicense",
            "cancelledCheque",
          ],
          properties: {
            name: { type: "string", example: "Brew & Bites" },
            description: { type: "string" },
            contactNumber: { type: "string", example: "9876543210" },
            email: { type: "string", format: "email" },
            ownerName: { type: "string" },
            ownerMobile: { type: "string", example: "9876543210" },
            aadhaarNumber: { type: "string", example: "123412341234" },
            address: { type: "string" },
            landmark: { type: "string" },
            city: { type: "string", example: "Ahmedabad" },
            state: { type: "string", example: "Gujarat" },
            pincode: { type: "string", example: "380001" },
            gstNumber: { type: "string", example: "24ABCDE1234F1Z5" },
            panNumber: { type: "string", example: "ABCDE1234F" },
            fssaiNumber: { type: "string", example: "12345678901234" },
            accountHolderName: { type: "string" },
            accountNumber: { type: "string", example: "123456789012" },
            ifscCode: { type: "string", example: "HDFC0001234" },
            deliveryEnabled: { type: "boolean", default: true },
            pickupEnabled: { type: "boolean", default: true },
            deliveryFee: { type: "number", default: 0 },

            logo: { type: "string", format: "binary" },
            coverImage: { type: "string", format: "binary" },
            galleryImages: {
              type: "array",
              maxItems: 10,
              items: { type: "string", format: "binary" },
            },
            panCardFront: { type: "string", format: "binary" },
            panCardBack: { type: "string", format: "binary" },
            identityFront: { type: "string", format: "binary" },
            identityBack: { type: "string", format: "binary" },
            foodLicense: { type: "string", format: "binary" },
            cancelledCheque: { type: "string", format: "binary" },
          },
        },
        CafeOwnerView: {
          type: "object",
          properties: {
            _id: { type: "string" },
            code: { type: "string", example: "CAFE-A1B2C3D4" },
            name: { type: "string" },
            description: { type: "string" },
            logo: { type: "string" },
            coverImage: { $ref: "#/components/schemas/FileObject" },
            galleryImages: {
              type: "array",
              items: { $ref: "#/components/schemas/FileObject" },
            },
            contactNumber: { type: "string" },
            email: { type: "string", format: "email" },
            address: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            pincode: { type: "string" },
            approvalStatus: { $ref: "#/components/schemas/ApprovalStatus" },
            isApproved: { type: "boolean" },
            isOpen: { type: "boolean" },
            isVisible: { type: "boolean" },
            isActive: { type: "boolean" },
            deliveryEnabled: { type: "boolean" },
            pickupEnabled: { type: "boolean" },
            deliveryFee: { type: "number" },
            platformFee: { type: "number" },
            rating: { $ref: "#/components/schemas/Rating" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        MyCafe: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["not_registered", "pending", "approved", "rejected"],
              example: "approved",
            },
            rejectionReason: { type: "string", nullable: true },
            cafe: {
              nullable: true,
              allOf: [{ $ref: "#/components/schemas/CafeOwnerView" }],
            },
          },
        },
        CafeOpenStatus: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string" },
            isOpen: { type: "boolean" },
          },
        },

        /* ---------------- CAFE: ADMIN ---------------- */
        CafeAdminSummary: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string" },
            city: { type: "string" },
            email: { type: "string", format: "email" },
            contactNumber: { type: "string" },
            approvalStatus: { $ref: "#/components/schemas/ApprovalStatus" },
            createdAt: { type: "string", format: "date-time" },
            owner: {
              type: "object",
              properties: {
                _id: { type: "string" },
                name: { type: "string" },
                email: { type: "string", format: "email" },
              },
            },
          },
        },
        CafeAdminDetail: {
          allOf: [
            { $ref: "#/components/schemas/CafeOwnerView" },
            {
              type: "object",
              properties: {
                aadhaarNumber: { type: "string", example: "123412341234" },
                panNumber: { type: "string", example: "ABCDE1234F" },
                gstNumber: { type: "string" },
                fssaiNumber: { type: "string" },
                accountHolderName: { type: "string" },
                accountNumber: { type: "string" },
                ifscCode: { type: "string" },
                rejectionReason: { type: "string" },
                documents: {
                  type: "object",
                  description: "Private documents returned as signed URLs",
                  properties: {
                    panCard: {
                      type: "object",
                      properties: {
                        front: { $ref: "#/components/schemas/FileObject" },
                        back: { $ref: "#/components/schemas/FileObject" },
                      },
                    },
                    identityProof: {
                      type: "object",
                      properties: {
                        front: { $ref: "#/components/schemas/FileObject" },
                        back: { $ref: "#/components/schemas/FileObject" },
                      },
                    },
                    foodLicense: { $ref: "#/components/schemas/FileObject" },
                    cancelledCheque: {
                      $ref: "#/components/schemas/FileObject",
                    },
                  },
                },
              },
            },
          ],
        },
        CafeApproveResult: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string" },
            approvalStatus: { type: "string", example: "approved" },
            code: { type: "string", example: "CAFE-A1B2C3D4" },
          },
        },
        CafeRejectResult: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string" },
            approvalStatus: { type: "string", example: "rejected" },
            rejectionReason: { type: "string" },
          },
        },

        /* ---------------- MENU ---------------- */
        MenuItemInput: {
          type: "object",
          required: ["name", "price"],
          properties: {
            name: { type: "string", example: "Cold Coffee", maxLength: 150 },
            description: {
              type: "string",
              example: "Chilled coffee with ice cream",
            },
            price: { type: "number", minimum: 0, example: 120 },
            category: {
              type: "string",
              default: "General",
              example: "Beverages",
            },
            isVeg: { type: "boolean", default: true },
            isAvailable: { type: "boolean", default: true },
            trackStock: {
              type: "boolean",
              default: false,
              description: "true = count stock, false = unlimited",
            },
            stock: { type: "integer", minimum: 0, example: 25 },
            image: { type: "string", format: "binary" },
          },
        },
        MenuItemUpdateInput: {
          type: "object",
          description:
            "All fields optional. Send only what you want to change.",
          properties: {
            name: { type: "string", example: "Cold Coffee Special" },
            description: { type: "string" },
            price: { type: "number", minimum: 0, example: 140 },
            category: { type: "string", example: "Beverages" },
            isVeg: { type: "boolean" },
            trackStock: { type: "boolean" },
            image: { type: "string", format: "binary" },
          },
        },
        MenuStockInput: {
          type: "object",
          description: "Send either `stock` or `adjust`, not both.",
          properties: {
            stock: {
              type: "integer",
              minimum: 0,
              example: 25,
              description: "Set exact quantity",
            },
            adjust: {
              type: "integer",
              example: -3,
              description:
                "Add (positive) or remove (negative) quantity. Non-zero.",
            },
            trackStock: {
              type: "boolean",
              description:
                "Optionally turn stock tracking on/off in the same call",
            },
          },
        },
        MenuItemOwnerView: {
          type: "object",
          properties: {
            _id: { type: "string", example: "665f1c2e9b1d8a0012a4b5c6" },
            cafe: { type: "string", example: "665f1c2e9b1d8a0012a4b5aa" },
            name: { type: "string", example: "Cold Coffee" },
            description: { type: "string" },
            price: { type: "number", example: 120 },
            category: { type: "string", example: "Beverages" },
            image: { $ref: "#/components/schemas/FileObject" },
            isVeg: { type: "boolean" },
            isAvailable: {
              type: "boolean",
              description: "Owner's manual switch",
            },
            trackStock: { type: "boolean" },
            stock: { type: "integer", example: 25 },
            inStock: {
              type: "boolean",
              description: "true when stock tracking is off or stock > 0",
            },
            orderable: {
              type: "boolean",
              description:
                "isAvailable AND inStock — can students order it now?",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        MenuItemPublic: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string", example: "Cold Coffee" },
            description: { type: "string" },
            price: { type: "number", example: 120 },
            category: { type: "string", example: "Beverages" },
            image: { $ref: "#/components/schemas/FileObject" },
            isVeg: { type: "boolean" },
            isAvailable: { type: "boolean", example: true },
            inStock: { type: "boolean", example: true },
            orderable: { type: "boolean", example: true },
          },
        },
        PublicMenu: {
          type: "object",
          properties: {
            cafe: {
              type: "object",
              properties: {
                _id: { type: "string" },
                name: { type: "string", example: "Brew & Bites" },
                isOpen: { type: "boolean" },
              },
            },
            menu: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string", example: "Beverages" },
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/MenuItemPublic" },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        BadRequest: {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Unauthorized: {
          description: "Invalid or expired token / wrong credentials",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Forbidden: {
          description: "Wrong role, deactivated account or invalid secret",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        NotFound: {
          description: "Resource not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Conflict: {
          description: "Conflict with current state / already exists",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },

  apis: [path.join(__dirname, "../routers/**/*.{ts,js}")],
});
