import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { NoQueryGuard } from './no-query.guard.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, NoQueryGuard],
  exports: [UsersService],
})
export class UsersModule {}
