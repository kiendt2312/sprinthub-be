import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionGuard } from './auth.guard.js';
import { EmptyBodyGuard } from './empty-body.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthRepository, AuthService, CsrfGuard, SessionGuard, EmptyBodyGuard],
  exports: [AuthRepository, AuthService, CsrfGuard, SessionGuard, EmptyBodyGuard],
})
export class AuthModule {}
