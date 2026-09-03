import bcrypt from 'bcryptjs'
import type { PasswordVerifier } from '../application/auth-ports.js'

export class BcryptPasswordVerifier implements PasswordVerifier {
  verify(password: string, passwordHash: string) {
    return bcrypt.compare(password, passwordHash)
  }
}
