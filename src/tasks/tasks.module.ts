import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { TasksController } from './tasks.controller.js';
import { TasksRepository } from './task.repository.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TasksController],
  providers: [TasksRepository, TasksService, NoQueryGuard],
  exports: [TasksRepository, TasksService],
})
export class TasksModule {}
