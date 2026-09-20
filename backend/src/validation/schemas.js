'use strict';

const { z } = require('zod');

/**
 * Structured validation schemas using Zod for API requests and domain objects.
 * Enforces strong contracts without altering existing HTTP response shapes.
 */

const loginSchema = z.object({
  identifier: z
    .string({ required_error: 'Identifier is required.' })
    .trim()
    .min(1, 'Identifier is required.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long.')
    .optional()
    .nullable()
    .or(z.literal('')),
});

const profileUpdateSchema = z.object({
  name: z
    .string({ required_error: 'name is required.' })
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be at most 100 characters.'),
});

const changePasswordSchema = z.object({
  currentPassword: z
    .string({ required_error: 'Current password is required.' })
    .min(1, 'Current password is required.'),
  newPassword: z
    .string({ required_error: 'New password is required.' })
    .min(8, 'Password must be at least 8 characters long.')
    .max(128, 'Password must be at most 128 characters long.'),
});

const createSellerSchema = z.object({
  name: z
    .string({ required_error: 'Name is required.' })
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be at most 100 characters.'),
  email: z
    .string({ required_error: 'A valid email is required.' })
    .trim()
    .min(1, 'A valid email is required.')
    .max(100, 'Email must be at most 100 characters.')
    .email('Enter a valid email address.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long.')
    .max(128, 'Password must be at most 128 characters long.')
    .optional()
    .nullable(),
  contact: z
    .string()
    .max(200, 'Contact must be at most 200 characters.')
    .optional()
    .nullable(),
});

const updateSellerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be at most 100 characters.')
    .optional(),
  status: z
    .enum(['active', 'inactive', 'blocked'], {
      errorMap: () => ({ message: 'Status must be one of: active, inactive, blocked.' }),
    })
    .optional(),
  contact: z
    .string()
    .max(200, 'Contact must be at most 200 characters.')
    .optional()
    .nullable(),
});

const passengerSchema = z.object({
  name: z
    .string({ required_error: 'Passenger name is required.' })
    .trim()
    .min(1, 'Passenger name is required.')
    .regex(/^[a-zA-Z\s]+$/, 'Passenger name may only contain letters and spaces.'),
  age: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 125, {
      message: 'Passenger age must be between 1 and 125.',
    }),
  gender: z.enum(['M', 'F', 'T', 'Male', 'Female', 'Transgender']).optional().default('M'),
  berthPreference: z.string().optional().default('No Preference'),
});

const saveTicketSchema = z.object({
  irctcAccountId: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => Number.isInteger(val) && val > 0, {
      message: 'Valid IRCTC Account ID is required.',
    }),
  name: z
    .string({ required_error: 'Ticket name is required.' })
    .trim()
    .min(1, 'Ticket name is required.')
    .max(100, 'Ticket name must be at most 100 characters.'),
  trainNumber: z
    .string({ required_error: 'Train number is required.' })
    .trim()
    .min(1, 'Train number is required.'),
  fromStation: z
    .string({ required_error: 'From station is required.' })
    .trim()
    .min(1, 'From station is required.'),
  toStation: z
    .string({ required_error: 'To station is required.' })
    .trim()
    .min(1, 'To station is required.'),
  journeyDate: z
    .string({ required_error: 'Journey date is required.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Journey date must be in YYYY-MM-DD format.'),
  quota: z.string().optional().default('General'),
  travelClass: z.string().optional().default('SL'),
  passengers: z
    .array(passengerSchema)
    .min(1, 'At least 1 passenger is required.')
    .max(6, 'At most 6 passengers allowed.'),
});

const targetAccountSchema = z.object({
  irctcUserId: z
    .string({ required_error: 'IRCTC User ID is required.' })
    .trim()
    .min(1, 'IRCTC User ID is required.'),
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, 'Password is required.'),
});

const bankSchema = z.object({
  bankName: z
    .string({ required_error: 'Bank name is required.' })
    .trim()
    .min(1, 'Bank name is required.'),
  userName: z.string().optional().nullable().default(''),
  password: z.string().optional().nullable().default(''),
  nameToSave: z.string().optional().nullable().default(''),
  gateway: z.string().optional().default('IRCTC'),
});

module.exports = {
  loginSchema,
  profileUpdateSchema,
  changePasswordSchema,
  createSellerSchema,
  updateSellerSchema,
  passengerSchema,
  saveTicketSchema,
  targetAccountSchema,
  bankSchema,
};

